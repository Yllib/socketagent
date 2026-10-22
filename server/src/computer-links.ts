import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";
import { z } from "zod";
import { computerAccessSchema, computerConfirmSchema, isValidPublicKey, normalizePublicKey } from "./device-registry";
import { decrypt, encrypt, fromBase64, toBase64, type KeyPair } from "./relay-crypto";
import { peerEventSchema, peerResponseSchema, type PeerAction, type PeerEvent, type PeerResponse } from "./computer-link-peer";
import type { ComputerApprovalToken, ComputerLinkSummary } from "./protocol";
import { errorMessage, isRecord } from "./value-guards";

const linkRecordSchema = z.object({
  name: z.string().min(1),
  targetPubkey: z.string().min(1),
  relayUrl: z.string().min(1),
  linkRoom: z.string().min(1),
  ticket: z.string().min(1),
  ticketExpiresAt: z.number(),
  access: computerAccessSchema,
  confirm: computerConfirmSchema,
  platform: z.string().optional(),
  shell: z.string().optional(),
  /** Unix ms when the link ends. Absent means it lasts until removed. */
  expiresAt: z.number().optional(),
});
export type ComputerLinkRecord = z.infer<typeof linkRecordSchema>;

const linksFileSchema = z.object({ version: z.literal(1), links: z.array(linkRecordSchema) });

/**
 * Outgoing links this computer holds. access, confirm, expiresAt, platform
 * and shell are a copy from the target's hello; the target enforces access,
 * confirm and expiry.
 */
export class ComputerLinkStore {
  private links: ComputerLinkRecord[] = [];

  constructor(private readonly filePath: string) {
    try {
      if (fs.existsSync(filePath)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
        this.links = linksFileSchema.parse(parsed).links;
      }
    } catch (err: unknown) {
      console.error(`[ComputerLinks] Could not read ${filePath}: ${errorMessage(err)}`);
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, links: this.links }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  list(): ComputerLinkRecord[] {
    return this.links.map((link) => ({ ...link }));
  }

  get(targetPubkey: string): ComputerLinkRecord | undefined {
    const link = this.links.find((candidate) => candidate.targetPubkey === targetPubkey);
    return link ? { ...link } : undefined;
  }

  set(record: ComputerLinkRecord): ComputerLinkRecord {
    const index = this.links.findIndex((candidate) => candidate.targetPubkey === record.targetPubkey);
    if (index >= 0) this.links[index] = { ...record };
    else this.links.push({ ...record });
    this.write();
    return { ...record };
  }

  remove(targetPubkey: string): boolean {
    const before = this.links.length;
    this.links = this.links.filter((candidate) => candidate.targetPubkey !== targetPubkey);
    if (this.links.length === before) return false;
    this.write();
    return true;
  }
}

export type LinkStatus = "offline" | "connecting" | "online";

interface PendingResponse {
  resolve: (response: PeerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * One outgoing connection to a target's link room. This computer joins as a
 * phone with a link ticket, then speaks the same NaCl box envelope the phone
 * lanes use, pinned to the target's server key.
 */
export class LinkConnection {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<string, PendingResponse>();
  private peerPresent = false;
  private approved = false;
  private requestCounter = 0;
  offlineReason: string | undefined = "Connecting";
  /** Set once the relay refuses the ticket; only a new ticket clears it. */
  ticketRejected = false;

  constructor(
    public record: ComputerLinkRecord,
    private readonly keyPair: KeyPair,
    private readonly hooks: {
      onEvent: (event: PeerEvent, record: ComputerLinkRecord) => void;
      onOnline: (record: ComputerLinkRecord) => void;
      onStatusChange?: () => void;
    },
  ) {}

  get status(): LinkStatus {
    if (this.peerPresent && this.approved && this.ws?.readyState === WebSocket.OPEN) return "online";
    return this.ws && !this.closed ? "connecting" : "offline";
  }

  get online(): boolean {
    return this.status === "online";
  }

  connect(): void {
    if (this.closed || this.ticketRejected) return;
    if (this.record.ticketExpiresAt <= Date.now()) {
      this.offlineReason = "The link ticket expired. Open the app to renew it.";
      return;
    }
    const url = `${this.record.relayUrl}?token=${encodeURIComponent(this.record.linkRoom)}&role=phone&link_ticket=${encodeURIComponent(this.record.ticket)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err: unknown) {
      this.offlineReason = errorMessage(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.offlineReason = "Connecting";
    // update() replaces the socket; events from the one it closed are ignored.
    const current = () => this.ws === ws;
    ws.on("open", () => {
      if (!current()) return;
      this.reconnectDelay = 1000;
      this.offlineReason = "Waiting for the target computer";
      this.startPing();
      this.hooks.onStatusChange?.();
    });
    ws.on("message", (data) => {
      if (!current()) return;
      try {
        const raw = (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString();
        this.handleFrame(JSON.parse(raw));
      } catch (err: unknown) {
        console.warn(`[ComputerLinks] ${this.record.name}: bad frame: ${errorMessage(err)}`);
      }
    });
    ws.on("close", (code, reason) => {
      if (!current()) return;
      this.stopPing();
      this.ws = null;
      this.peerPresent = false;
      this.approved = false;
      this.failPending(new Error(`${this.record.name} disconnected`));
      if (code === 1008 || code === 4401) {
        this.ticketRejected = true;
        this.offlineReason = `The relay refused the link ticket${reason.length ? `: ${reason.toString()}` : ""}`;
      } else if (!this.ticketRejected) {
        this.offlineReason = "Relay connection lost";
        this.scheduleReconnect();
      }
      this.hooks.onStatusChange?.();
    });
    ws.on("error", (err) => {
      if (current()) this.offlineReason = err.message;
    });
    // The relay answers a bad, expired or foreign ticket with HTTP 401 before
    // the socket opens. ws reports that here and emits nothing else once the
    // request is destroyed, so the cleanup "close" would do happens here.
    ws.on("unexpected-response", (req, res) => {
      req.destroy();
      if (!current()) return;
      this.ws = null;
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.ticketRejected = true;
        this.offlineReason = "The relay refused the link ticket. Open the app to renew it.";
      } else {
        this.offlineReason = `Relay refused the connection (HTTP ${res.statusCode ?? "?"})`;
        this.scheduleReconnect();
      }
      this.hooks.onStatusChange?.();
    });
  }

  /** Replaces the stored record (new ticket or settings) and reconnects if needed. */
  update(record: ComputerLinkRecord): void {
    const ticketChanged = record.ticket !== this.record.ticket || record.linkRoom !== this.record.linkRoom
      || record.relayUrl !== this.record.relayUrl;
    this.record = record;
    if (ticketChanged) {
      this.ticketRejected = false;
      this.stopPing();
      this.ws?.close();
      this.ws = null;
      this.peerPresent = false;
      this.approved = false;
      this.failPending(new Error(`${this.record.name} reconnected with a new ticket`));
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.connect();
    } else if (!this.ws && !this.closed) {
      this.connect();
    }
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.failPending(new Error(`${this.record.name} link removed`));
  }

  private handleFrame(parsed: unknown): void {
    if (!isRecord(parsed)) return;
    if (parsed.type === "peer_connected") {
      this.peerPresent = true;
      this.approved = false;
      this.sendPlain({ type: "key_exchange", pubkey: toBase64(this.keyPair.publicKey) });
      return;
    }
    if (parsed.type === "peer_disconnected") {
      this.peerPresent = false;
      this.approved = false;
      this.offlineReason = `${this.record.name} is offline`;
      this.failPending(new Error(`${this.record.name} went offline`));
      this.hooks.onStatusChange?.();
      return;
    }
    if (parsed.type === "subscription_required") {
      this.ticketRejected = true;
      this.offlineReason = "The relay refused the link ticket. Open the app to renew it.";
      return;
    }
    if (parsed.type === "key_exchange_ack") {
      if (parsed.device === "pending") {
        // A device_auth_result follows with the reason. Computers never token-enroll.
        this.offlineReason = `${this.record.name} has not authorized this computer`;
        return;
      }
      this.markOnline();
      return;
    }
    if (typeof parsed.n === "string" && typeof parsed.c === "string") {
      let plaintext: string;
      try {
        plaintext = decrypt({ n: parsed.n, c: parsed.c }, fromBase64(this.record.targetPubkey), this.keyPair.secretKey);
      } catch {
        console.warn(`[ComputerLinks] ${this.record.name}: could not decrypt a frame; is the target key right?`);
        return;
      }
      this.handleEncrypted(JSON.parse(plaintext));
    }
  }

  private markOnline(): void {
    this.approved = true;
    this.offlineReason = undefined;
    this.hooks.onStatusChange?.();
    this.hooks.onOnline(this.record);
  }

  private handleEncrypted(parsed: unknown): void {
    if (!isRecord(parsed)) return;
    if (parsed.type === "device_auth_result") {
      if (parsed.ok === true) {
        this.markOnline();
      } else {
        this.approved = false;
        this.offlineReason = parsed.reason === "wrong_lane" || parsed.reason === "not_approved" || parsed.reason === "removed"
          ? `${this.record.name} has not authorized this computer`
          : `${this.record.name} refused the connection (${String(parsed.reason || "unknown")})`;
        this.failPending(new Error(this.offlineReason));
        this.hooks.onStatusChange?.();
        // The target cannot push a later authorization to a dropped peer, so
        // try a fresh handshake in a minute.
        const retry = setTimeout(() => this.ws?.close(), 60_000);
        retry.unref?.();
      }
      return;
    }
    if (parsed.type === "peer_response") {
      const response = peerResponseSchema.safeParse(parsed);
      if (!response.success) return;
      const waiting = this.pending.get(response.data.id);
      if (!waiting) return;
      this.pending.delete(response.data.id);
      clearTimeout(waiting.timer);
      waiting.resolve(response.data);
      return;
    }
    if (parsed.type === "peer_event") {
      const event = peerEventSchema.safeParse(parsed);
      if (!event.success) return;
      this.hooks.onEvent(event.data, this.record);
    }
  }

  private sendPlain(message: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private sendEncrypted(message: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error(`${this.record.name} is offline`);
    const envelope = encrypt(JSON.stringify(message), fromBase64(this.record.targetPubkey), this.keyPair.secretKey);
    this.ws.send(JSON.stringify(envelope));
  }

  /** Sends one peer_request and waits for its peer_response. */
  request(
    action: PeerAction,
    args: Record<string, unknown>,
    sourceSessionId: string,
    approval?: ComputerApprovalToken,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<PeerResponse> {
    if (!this.online) {
      return Promise.reject(new Error(this.offlineReason || `${this.record.name} is offline`));
    }
    const id = `${Date.now().toString(36)}-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.record.name} did not answer in time`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendEncrypted({ type: "peer_request", id, action, args, sourceSessionId, ...(approval ? { approval } : {}) });
      } catch (err: unknown) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private failPending(error: Error): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
      this.pending.delete(id);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, 30_000);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectTimer.unref?.();
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }
}

/** Keeps one LinkConnection per stored link and resolves computers by name or key. */
export class ComputerLinkManager {
  private connections = new Map<string, LinkConnection>();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: ComputerLinkStore,
    private readonly keyPair: KeyPair,
    private readonly hooks: {
      onEvent: (event: PeerEvent, record: ComputerLinkRecord) => void;
      onOnline: (record: ComputerLinkRecord) => void;
      onStatusChange?: () => void;
    },
  ) {}

  start(): void {
    this.dropExpired();
    for (const record of this.store.list()) this.open(record);
    this.expiryTimer = setInterval(() => this.dropExpired(), 60_000);
    this.expiryTimer.unref?.();
  }

  /** Links past their expiresAt disconnect and are forgotten. */
  private dropExpired(): void {
    const now = Date.now();
    for (const record of this.store.list()) {
      if (record.expiresAt !== undefined && record.expiresAt <= now) this.remove(record.targetPubkey);
    }
  }

  private open(record: ComputerLinkRecord): LinkConnection {
    const existing = this.connections.get(record.targetPubkey);
    if (existing) {
      existing.update(record);
      return existing;
    }
    const connection = new LinkConnection(record, this.keyPair, this.hooks);
    this.connections.set(record.targetPubkey, connection);
    connection.connect();
    return connection;
  }

  set(record: ComputerLinkRecord): ComputerLinkRecord {
    if (!isValidPublicKey(record.targetPubkey)) throw new Error("targetPubkey must be a base64 X25519 key");
    const saved = this.store.set({ ...record, targetPubkey: normalizePublicKey(record.targetPubkey) });
    this.open(saved);
    return saved;
  }

  remove(targetPubkey: string): boolean {
    const connection = this.connections.get(targetPubkey);
    connection?.close();
    this.connections.delete(targetPubkey);
    return this.store.remove(targetPubkey);
  }

  list(): ComputerLinkSummary[] {
    this.dropExpired();
    return this.store.list().map((record) => {
      const connection = this.connections.get(record.targetPubkey);
      return {
        name: record.name,
        targetPubkey: record.targetPubkey,
        online: connection?.online === true,
        ...(connection?.online ? {} : { offlineReason: connection?.offlineReason || "Not connected" }),
        access: record.access,
        confirm: record.confirm,
        ticketExpiresAt: record.ticketExpiresAt,
        ...(record.platform ? { platform: record.platform } : {}),
        ...(record.shell ? { shell: record.shell } : {}),
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
      };
    });
  }

  /** A link whose name matches case-insensitively, or whose key matches exactly. */
  find(computer: string): LinkConnection | undefined {
    const wanted = computer.trim();
    if (!wanted) return undefined;
    this.dropExpired();
    const byKey = this.connections.get(wanted);
    if (byKey) return byKey;
    const lower = wanted.toLowerCase();
    for (const connection of this.connections.values()) {
      if (connection.record.name.toLowerCase() === lower) return connection;
    }
    return undefined;
  }

  get(targetPubkey: string): LinkConnection | undefined {
    this.dropExpired();
    return this.connections.get(targetPubkey);
  }

  closeAll(): void {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}
