import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { decryptBinary, encryptBinary, type KeyPair } from "./relay-crypto";
import type { TransferJobConfig } from "./protocol";
import type { SessionTransferExportResult, SessionTransferImportResult } from "./session-transfer";

const CHUNK = 512 * 1024;
const WINDOW = 4;
const MAX_BUNDLE = 256 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

type Phase = "preparing" | "waiting" | "transferring" | "importing" | "finalizing" | "completed" | "failed";
type Manifest = Pick<SessionTransferExportResult, "fileSize" | "sha256">;
interface Job {
  config: TransferJobConfig;
  phase: Phase;
  bytes: number;
  manifest?: Manifest;
  sourceRevision?: string;
  result?: SessionTransferImportResult;
  error?: string;
  warning?: string;
  settled?: boolean;
}
interface Hooks {
  export(sessionId: string): Promise<SessionTransferExportResult>;
  import(config: TransferJobConfig, bundlePath: string, sha256: string): Promise<SessionTransferImportResult>;
  revision(sessionId: string): string;
  archive(sessionId: string, revision: string): Promise<string | undefined>;
  changed?(): void;
}
interface Runtime { ws?: WebSocket; timer?: NodeJS.Timeout; chain: Promise<void>; preparing: boolean; attempt: number }
interface Header { jobId: string; type: string; offset?: number; fileSize?: number; sha256?: string; result?: SessionTransferImportResult; error?: string }

function durableJson(file: string, value: unknown): void {
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  // Windows does not support opening directories for fsync.
  if (process.platform !== "win32") {
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}
function hash(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }

/** Owns durable transfers independently of connected phones. Only authenticated ciphertext crosses the relay. */
export class SessionTransferJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly runtime = new Map<string, Runtime>();
  private closed = false;
  constructor(private readonly directory: string, private readonly keys: KeyPair, private readonly hooks: Hooks) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(directory)) {
      if (!UUID.test(entry)) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(directory, entry, "job.json"), "utf8")) as Job;
        this.validate(job.config);
        if (job.config.jobId !== entry) continue;
        this.jobs.set(entry, job);
      } catch { /* Incomplete staging directories have no accepted job. */ }
    }
  }
  resume(): void {
    for (const job of this.jobs.values()) if (job.phase !== "failed" && !job.settled) this.launch(job);
  }
  close(): void {
    this.closed = true;
    for (const runtime of this.runtime.values()) { clearTimeout(runtime.timer); runtime.ws?.terminate(); }
  }
  private folder(job: Job): string { return path.join(this.directory, job.config.jobId); }
  private bundle(job: Job): string { return path.join(this.folder(job), "bundle.gz"); }
  private save(job: Job): void { durableJson(path.join(this.folder(job), "job.json"), job); this.hooks.changed?.(); }
  private receipt(job: Job): SessionTransferImportResult | undefined {
    if (!job.result) return undefined;
    const { id, title, cwd, createdAt, lastActive, messagePreview, backend, transferLineage } = job.result.session;
    // Progress/receipts need a destination identity, not handoff context or agent settings.
    return { ...job.result, session: { id, title, cwd, createdAt, lastActive, messagePreview, backend, transferLineage } };
  }
  private state(job: Job) {
    return { jobId: job.config.jobId, role: job.config.role, sessionId: job.config.sessionId,
      phase: job.phase, bytes: job.bytes, totalBytes: job.manifest?.fileSize || 0,
      result: this.receipt(job), error: job.error, warning: job.warning,
      targetCwd: job.config.targetCwd, targetBackend: job.config.targetBackend,
      mode: job.config.mode, peerPublicKey: job.config.peerPublicKey };
  }
  status(jobId: string) { const job = this.jobs.get(jobId); return job ? this.state(job) : undefined; }
  list() { return [...this.jobs.values()].map(job => this.state(job)); }
  private validate(c: TransferJobConfig): void {
    if (!c || !UUID.test(c.jobId) || !["source", "destination", "local"].includes(c.role)
      || typeof c.sessionId !== "string" || !c.sessionId || c.sessionId.length > 200
      || typeof c.targetCwd !== "string" || !c.targetCwd.trim()
      || !["claude", "codex"].includes(c.targetBackend) || !["move", "clone"].includes(c.mode)
      || !["exact", "handoff"].includes(c.nativeMode)) throw new Error("Invalid transfer configuration");
    if (c.role !== "local") {
      const url = new URL(c.relayUrl || "");
      if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password
        || typeof c.ticket !== "string" || c.ticket.length > 2048 || !c.ticket
        || typeof c.peerPublicKey !== "string" || Buffer.from(c.peerPublicKey, "base64").length !== 32) {
        throw new Error("Invalid transfer connection");
      }
    }
  }
  start(config: TransferJobConfig) {
    this.validate(config);
    const existing = this.jobs.get(config.jobId);
    if (existing) {
      // Renew credentials, but never allow a retry to change the authorized operation or identity.
      const identity = (c: TransferJobConfig) => JSON.stringify({ ...c, ticket: undefined });
      if (identity(existing.config) !== identity(config)) throw new Error("Transfer ID already belongs to another operation");
      const renewed = existing.config.ticket !== config.ticket;
      existing.config.ticket = config.ticket;
      if (existing.phase === "failed") { existing.phase = "waiting"; existing.error = undefined; }
      this.save(existing);
      if (renewed) this.getRuntime(existing).ws?.close();
      this.launch(existing);
      return this.state(existing);
    }
    if ([...this.jobs.values()].filter(j => !j.settled && j.phase !== "failed").length >= 16) throw new Error("Too many active transfers");
    const job: Job = { config: { ...config }, phase: "preparing", bytes: 0 };
    fs.mkdirSync(this.folder(job), { recursive: true, mode: 0o700 });
    this.save(job);
    this.jobs.set(config.jobId, job);
    this.launch(job);
    return this.state(job);
  }
  private getRuntime(job: Job): Runtime {
    let value = this.runtime.get(job.config.jobId);
    if (!value) { value = { chain: Promise.resolve(), preparing: false, attempt: 0 }; this.runtime.set(job.config.jobId, value); }
    return value;
  }
  private fail(job: Job, error: unknown, notifyPeer = true): void {
    if (this.closed) return;
    if (job.phase === "completed") {
      job.settled = true; this.save(job); this.getRuntime(job).ws?.close(); return;
    }
    job.phase = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    this.save(job);
    if (notifyPeer) this.send(job, { type: "failed", error: job.error.slice(0, 1000) });
    const rt = this.getRuntime(job);
    clearTimeout(rt.timer); rt.ws?.close();
  }
  private launch(job: Job): void {
    const rt = this.getRuntime(job);
    if (this.closed || rt.preparing || rt.ws || job.settled) return;
    clearTimeout(rt.timer);
    rt.preparing = true;
    void (async () => {
      if (job.config.role !== "destination" && !job.manifest) {
        const revision = this.hooks.revision(job.config.sessionId);
        const exported = await this.hooks.export(job.config.sessionId);
        if (revision !== this.hooks.revision(job.config.sessionId)) {
          fs.rmSync(exported.bundlePath, { force: true });
          throw new Error("The source session changed while preparing. Wait until it is idle and retry.");
        }
        fs.renameSync(exported.bundlePath, this.bundle(job));
        job.manifest = { fileSize: exported.fileSize, sha256: exported.sha256 };
        job.sourceRevision = revision;
        job.phase = "waiting";
        this.save(job);
      }
      if (this.closed) return;
      if (job.config.role === "local") {
        if (!job.result) await this.import(job);
        await this.finishSource(job);
        job.settled = true; this.save(job);
      } else this.connect(job);
    })().catch(error => this.fail(job, error)).finally(() => { rt.preparing = false; });
  }
  private connect(job: Job): void {
    const rt = this.getRuntime(job);
    const url = new URL(job.config.relayUrl!);
    url.pathname = "/session-transfer"; url.search = ""; url.hash = "";
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${job.config.ticket}` },
      handshakeTimeout: 15_000, maxPayload: CHUNK + 16_384 });
    rt.ws = ws;
    let lastMessage = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - lastMessage > 45_000) ws.terminate(); }, 15_000);
    watchdog.unref();
    ws.on("ping", () => { lastMessage = Date.now(); });
    ws.on("message", (raw, binary) => {
      lastMessage = Date.now();
      if (rt.ws !== ws || this.closed) return;
      rt.chain = rt.chain.then(async () => {
        if (rt.ws !== ws || this.closed || job.phase === "failed") return;
        const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        if (!binary) {
          const signal = JSON.parse(data.toString()) as { type?: string };
          if (signal.type === "peer_ready") {
            rt.attempt = 0;
            this.hello(job);
          }
          return;
        }
        const plain = Buffer.from(decryptBinary(data, Buffer.from(job.config.peerPublicKey!, "base64"), this.keys.secretKey));
        if (plain.length < 4) throw new Error("Invalid transfer frame");
        const length = plain.readUInt32BE(0);
        if (length > 8192 || length > plain.length - 4) throw new Error("Invalid transfer header");
        const header = JSON.parse(plain.subarray(4, 4 + length).toString()) as Header;
        if (header.jobId !== job.config.jobId) throw new Error("Transfer identity mismatch");
        await this.receive(job, header, plain.subarray(4 + length));
      }).catch(error => this.fail(job, error));
    });
    ws.on("error", () => {}); // Connection errors retry with the same durable offset.
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      if (response.statusCode === 401 || response.statusCode === 403) this.fail(job, new Error("Transfer authorization expired. Reopen Teleport and retry."));
      ws.terminate();
    });
    ws.on("close", () => {
      clearInterval(watchdog);
      if (rt.ws !== ws) return;
      rt.ws = undefined;
      if (!this.closed && job.config.role === "source" && job.phase === "completed") {
        job.settled = true; this.save(job);
      }
      if (!this.closed && !job.settled && job.phase !== "failed") {
        // Queue reconnection after pending disk/import work from this connection.
        rt.chain = rt.chain.then(() => {
          if (this.closed || job.settled || job.phase === "failed") return;
          rt.timer = setTimeout(() => this.launch(job), Math.min(30_000, 500 * 2 ** Math.min(rt.attempt++, 6)));
          rt.timer.unref();
        });
      }
    });
  }
  private send(job: Job, header: Omit<Header, "jobId">, bytes = Buffer.alloc(0)): void {
    const ws = this.getRuntime(job).ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const json = Buffer.from(JSON.stringify({ ...header, jobId: job.config.jobId }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(json.length);
    ws.send(encryptBinary(Buffer.concat([prefix, json, bytes]), Buffer.from(job.config.peerPublicKey!, "base64"), this.keys.secretKey));
  }
  private hello(job: Job): void {
    if (job.config.role === "source") {
      if (job.phase === "completed") this.send(job, { type: "finalized" });
      else this.send(job, { type: "manifest", ...job.manifest! });
    } else if (job.result) {
      this.send(job, { type: "imported", result: this.receipt(job) });
    }
  }
  private async import(job: Job): Promise<void> {
    job.phase = "importing"; this.save(job);
    if (job.config.role === "destination") this.send(job, { type: "importing", offset: job.bytes });
    job.result = await this.hooks.import(job.config, this.bundle(job), job.manifest!.sha256);
    job.phase = "completed"; this.save(job);
  }
  private async finishSource(job: Job): Promise<void> {
    job.bytes = job.manifest!.fileSize;
    job.phase = "finalizing"; this.save(job);
    if (job.config.mode === "move") job.warning = await this.hooks.archive(job.config.sessionId, job.sourceRevision!);
    job.phase = "completed"; this.save(job);
  }
  private async receive(job: Job, header: Header, bytes: Buffer): Promise<void> {
    if (header.type === "failed") {
      this.fail(job, new Error(typeof header.error === "string" ? header.error.slice(0, 1000) : "The other computer paused this transfer"), false);
      return;
    }
    if (job.config.role === "source") {
      if (job.phase === "completed" && header.type !== "done") {
        this.send(job, { type: "finalized" }); return;
      }
      if (header.type === "progress" || header.type === "importing") {
        if (!Number.isSafeInteger(header.offset) || header.offset! < 0 || header.offset! > job.manifest!.fileSize) throw new Error("Invalid progress offset");
        job.bytes = Math.max(job.bytes, header.offset!);
        job.phase = header.type === "importing" ? "importing" : "transferring";
        this.save(job);
      } else if (header.type === "pull") {
        const offset = header.offset;
        if (!Number.isSafeInteger(offset) || offset! < 0 || offset! > job.manifest!.fileSize) throw new Error("Invalid resume offset");
        job.bytes = offset!; job.phase = "transferring"; this.save(job);
        const fd = fs.openSync(this.bundle(job), "r");
        try {
          for (let i = 0, position = offset!; i < WINDOW && position < job.manifest!.fileSize; i++) {
            const chunk = Buffer.alloc(Math.min(CHUNK, job.manifest!.fileSize - position));
            const count = fs.readSync(fd, chunk, 0, chunk.length, position);
            if (count !== chunk.length) throw new Error("Source bundle is incomplete");
            this.send(job, { type: "chunk", offset: position, sha256: hash(chunk) }, chunk);
            position += chunk.length;
          }
        } finally { fs.closeSync(fd); }
      } else if (header.type === "imported") {
        if (!header.result?.session?.id || header.result.sourceSessionId !== job.config.sessionId
          || header.result.session.transferLineage?.transferId !== job.config.jobId) throw new Error("Invalid destination receipt");
        if (!job.result) { job.result = header.result; this.save(job); }
        if (job.phase !== "completed") await this.finishSource(job);
        this.send(job, { type: "finalized" });
      } else if (header.type === "done" && job.phase === "completed") {
        job.settled = true; this.save(job); this.getRuntime(job).ws?.close();
      }
      return;
    }
    if (header.type === "manifest") {
      if (job.result) { this.hello(job); return; }
      if (!Number.isSafeInteger(header.fileSize) || header.fileSize! <= 0 || header.fileSize! > MAX_BUNDLE
        || !/^[a-f0-9]{64}$/.test(header.sha256 || "")) throw new Error("Invalid transfer manifest");
      const manifest = { fileSize: header.fileSize!, sha256: header.sha256! };
      if (job.manifest && JSON.stringify(job.manifest) !== JSON.stringify(manifest)) throw new Error("Source bundle changed during transfer");
      job.manifest = manifest;
      if (!fs.existsSync(this.bundle(job))) {
        if (job.bytes) throw new Error("Saved transfer data is missing");
        fs.writeFileSync(this.bundle(job), Buffer.alloc(0), { mode: 0o600 });
      }
      if (fs.statSync(this.bundle(job)).size < job.bytes) throw new Error("Saved transfer data is incomplete");
      fs.truncateSync(this.bundle(job), job.bytes);
      job.phase = "transferring"; this.save(job);
      if (job.bytes === manifest.fileSize) { await this.import(job); this.hello(job); }
      else this.send(job, { type: "pull", offset: job.bytes });
    } else if (header.type === "chunk" && job.manifest && !job.result) {
      if (header.offset !== job.bytes) return; // Duplicate from a previous connection/batch.
      if (bytes.length !== Math.min(CHUNK, job.manifest.fileSize - job.bytes) || hash(bytes) !== header.sha256) throw new Error("Transfer chunk checksum mismatch");
      const fd = fs.openSync(this.bundle(job), "r+");
      try { fs.writeSync(fd, bytes, 0, bytes.length, job.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      job.bytes += bytes.length; this.save(job);
      this.send(job, { type: "progress", offset: job.bytes });
      if (job.bytes === job.manifest.fileSize) { await this.import(job); this.hello(job); }
      else if (job.bytes % (CHUNK * WINDOW) === 0) this.send(job, { type: "pull", offset: job.bytes });
      // A resumed batch may start between normal boundaries. Requesting at a boundary is safe:
      // queued duplicates are ignored by the exact offset check above.
    } else if (header.type === "finalized" && job.result) {
      job.phase = "completed"; job.settled = true; this.save(job);
      this.send(job, { type: "done" });
      this.getRuntime(job).ws?.close();
      // Keep the receiver available until the sender closes, so a lost final receipt is replayable.
    }
  }
}
