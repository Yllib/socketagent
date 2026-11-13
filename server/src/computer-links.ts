import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";
import { z } from "zod";
import { computerAccessSchema, computerConfirmSchema, isValidPublicKey, normalizePublicKey } from "./device-registry";
import {
  PeerChannel,
  SessionKeyedPeerStore,
  SessionOffer,
  fromBase64,
  type KeyPair,
  type SessionKeyedPeers,
} from "./relay-crypto";
import { peerEventSchema, peerResponseSchema, type PeerAction, type PeerEvent, type PeerResponse } from "./computer-link-peer";
import { initiateHandshake, NoiseError, type NoiseInitiatorHandshake } from "./noise-ikpsk1";
import type { ComputerApprovalToken, ComputerLinkSummary } from "./protocol";
import {
  buildPrologue,
  derivePsk,
  encodeHandshakePayload,
  encodeHs1Frame,
  parseHandshakePayload,
  parseHs2Frame,
  secretTag,
  TransportChannel,
  TRANSPORT_READY_MESSAGE,
  type FrameChannel,
} from "./transport-v2";
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
  /**
   * base64 of 32 bytes, shared with the target. A link that has one connects
   * with transport v2 and never falls back to the old key exchange.
   */
  linkSecret: z.string().refine(isValidPublicKey, "must be base64 of 32 bytes").optional(),
});
export type ComputerLinkRecord = z.infer<typeof linkRecordSchema>;

const linksFileSchema = z.object({ version: z.literal(1), links: z.array(linkRecordSchema) });

/**
 * Outgoing links this computer holds. access, confirm, expiresAt, platform
 * and shell are a copy from the target's hello; the target enforces access,
 * confirm and expiry. The file holds link secrets, so it is written 0600.
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
/** How long the source waits for `hs2`, and for the answer to `link_upgrade`. */
const HANDSHAKE_WAIT_MS = 10_000;
/** After a handshake the target did not answer or answered badly, the next dial waits this long. */
const FAILED_HANDSHAKE_RETRY_MS = 60_000;

export interface LinkHooks {
  onEvent: (event: PeerEvent, record: ComputerLinkRecord) => void;
  onOnline: (record: ComputerLinkRecord) => void;
  onStatusChange?: () => void;
  /** Targets that answered with session keys and may not fall back. Defaults to memory. */
  sessionKeyedPeers?: SessionKeyedPeers;
  /** This server's release version, sent in the v2 handshake. */
  serverVersion: string;
  /**
   * False when the old path is off on this computer. A link with no link
   * secret then does not connect at all. Default true.
   */
  legacyTransport?: boolean;
  /** Stores a record whose link secret the target has just accepted. Set by the manager. */
  saveRecord?: (record: ComputerLinkRecord) => void;
}

/**
 * One outgoing connection to a target's link room. This computer joins as a
 * phone with a link ticket, pinned to the target's server key.
 *
 * A link whose record has a link secret runs transport v2 (wire spec 5.4):
 * on `peer_connected` it sends `hs1` on the `link` lane, and after `hs2` every
 * frame is a sealed record. It never sends the old key exchange.
 *
 * A link with no secret speaks the old NaCl box envelope, with a session key
 * per connection once the target answers with one. On such a session-keyed
 * channel it makes a link secret and offers it with `link_upgrade` (10.2).
 * When the target accepts, the secret is stored and the link reconnects on
 * v2. An older target refuses the action and the link stays as it is until
 * the next connect.
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
  private offer: SessionOffer | null = null;
  private channel: FrameChannel | null = null;
  /** The v2 handshake in flight, from `hs1` until `hs2` arrives or the wait ends. */
  private handshake: NoiseInitiatorHandshake | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The shortest wait before the next dial. Set after a handshake that failed. */
  private retryFloorMs = 0;
  private readonly sessionKeyedPeers: SessionKeyedPeers;
  offlineReason: string | undefined = "Connecting";
  /** Set once the relay refuses the ticket; only a new ticket clears it. */
  ticketRejected = false;

  constructor(
    public record: ComputerLinkRecord,
    private readonly keyPair: KeyPair,
    private readonly hooks: LinkHooks,
  ) {
    this.sessionKeyedPeers = hooks.sessionKeyedPeers ?? new SessionKeyedPeerStore();
  }

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
    if (!this.record.linkSecret && this.hooks.legacyTransport === false) {
      this.offlineReason = "This link uses the old transport, which is off on this computer. Make the link again in the app.";
      return;
    }
    let ws: WebSocket;
    try {
      // A new-style join: the room and the ticket ride in headers, not the URL.
      ws = new WebSocket(this.record.relayUrl, {
        headers: {
          "X-SocketAgent-Protocol": "2",
          "X-SocketAgent-Role": "phone",
          "X-SocketAgent-Room": encodeURIComponent(this.record.linkRoom),
          "X-SocketAgent-Link-Ticket": this.record.ticket,
        },
      });
    } catch (err: unknown) {
      this.offlineReason = errorMessage(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // A session belongs to one socket. Frames from an older one never open here.
    this.dropChannel();
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
        this.handleFrame(JSON.parse(raw), raw);
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
      this.dropChannel();
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

  /** Replaces the stored record (new ticket, link secret or settings) and reconnects if needed. */
  update(record: ComputerLinkRecord): void {
    const ticketChanged = record.ticket !== this.record.ticket || record.linkRoom !== this.record.linkRoom
      || record.relayUrl !== this.record.relayUrl;
    const secretChanged = record.linkSecret !== this.record.linkSecret;
    this.record = record;
    if (ticketChanged || secretChanged) {
      if (ticketChanged) this.ticketRejected = false;
      this.retryFloorMs = 0;
      this.redial(new Error(`${this.record.name} reconnected with a new ${ticketChanged ? "ticket" : "link secret"}`));
    } else if (!this.ws && !this.closed) {
      this.connect();
    }
  }

  /** Drops the socket and dials again at once. */
  private redial(why: Error): void {
    this.stopPing();
    this.ws?.close();
    this.ws = null;
    this.peerPresent = false;
    this.approved = false;
    this.dropChannel();
    this.failPending(why);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  /** Forgets the channel and any handshake in flight. Both belong to one socket and one `peer_connected`. */
  private dropChannel(): void {
    this.channel = null;
    this.offer = null;
    this.handshake = null;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.dropChannel();
    this.failPending(new Error(`${this.record.name} link removed`));
  }

  private handleFrame(parsed: unknown, raw: string): void {
    if (!isRecord(parsed)) return;
    if (parsed.type === "peer_connected") {
      this.peerPresent = true;
      this.approved = false;
      this.dropChannel();
      if (this.record.linkSecret) {
        this.startHandshake(this.record.linkSecret);
        return;
      }
      this.offer = new SessionOffer(this.keyPair, fromBase64(this.record.targetPubkey));
      this.sendPlain(this.offer.message());
      return;
    }
    if (parsed.type === "peer_disconnected") {
      this.peerPresent = false;
      this.approved = false;
      this.dropChannel();
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
    if (parsed.type === "hs2") {
      this.handleHs2(raw);
      return;
    }
    if (parsed.type === "key_exchange_ack") {
      // A link with a secret never set an offer, so it never takes this path.
      if (!this.offer) return;
      try {
        this.channel = this.offer.accept(parsed, this.sessionKeyedPeers);
      } catch (err: unknown) {
        // Either a bad answer or a downgrade to the static box; both mean
        // the frames that follow cannot be trusted.
        this.channel = null;
        this.offlineReason = `${this.record.name} answered with an unusable key exchange`;
        console.warn(`[ComputerLinks] ${this.record.name}: key exchange refused: ${errorMessage(err)}`);
        this.hooks.onStatusChange?.();
        this.ws?.close();
        return;
      } finally {
        this.offer = null;
      }
      if (parsed.device === "pending") {
        // A device_auth_result follows with the reason. Computers never token-enroll.
        this.offlineReason = `${this.record.name} has not authorized this computer`;
        return;
      }
      this.markOnline();
      return;
    }
    if (typeof parsed.n === "string" && typeof parsed.c === "string") {
      if (!this.channel) return;
      let plaintext: string;
      try {
        plaintext = this.channel.openText({ n: parsed.n, c: parsed.c });
      } catch (err: unknown) {
        console.warn(`[ComputerLinks] ${this.record.name}: frame refused: ${errorMessage(err)}`);
        // A v2 channel is closed for good by a record that does not open.
        if (this.channel instanceof TransportChannel) this.ws?.close();
        return;
      }
      this.handleEncrypted(JSON.parse(plaintext));
    }
  }

  /** Sends `hs1` on the link lane and waits 10 s for the target's `hs2`. */
  private startHandshake(linkSecret: string): void {
    const secret = Buffer.from(linkSecret, "base64");
    this.handshake = initiateHandshake({
      prologue: buildPrologue("relay", "link", this.record.linkRoom),
      staticKeyPair: this.keyPair,
      responderStaticKey: fromBase64(this.record.targetPubkey),
      psk: derivePsk(secret),
      payload: encodeHandshakePayload({ app: this.hooks.serverVersion }),
    });
    this.sendFrame(encodeHs1Frame({ path: "relay", lane: "link", tag: secretTag(secret), message: Buffer.from(this.handshake.message1) }));
    // The target stays silent for a key or secret it does not have on record.
    this.handshakeTimer = setTimeout(() => this.failHandshake(`${this.record.name} has not authorized this computer`), HANDSHAKE_WAIT_MS);
    this.handshakeTimer.unref?.();
  }

  /** The first `hs2` decides the handshake (spec 3.7). A bad one closes the socket. */
  private handleHs2(raw: string): void {
    const handshake = this.handshake;
    if (!handshake) return;
    this.handshake = null;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const message2 = parseHs2Frame(raw);
    if (!message2) {
      this.failHandshake(`${this.record.name} answered with an unusable handshake`);
      return;
    }
    let keys: ReturnType<NoiseInitiatorHandshake["readMessage2"]>;
    try {
      keys = handshake.readMessage2(message2);
    } catch (err: unknown) {
      if (!(err instanceof NoiseError)) throw err;
      this.failHandshake(`${this.record.name} answered with an unusable handshake`);
      return;
    }
    // A link is only ever answered `open`.
    if (parseHandshakePayload(keys.payload)?.status !== "open") {
      this.failHandshake(`${this.record.name} refused the connection`);
      return;
    }
    this.channel = new TransportChannel({ role: "initiator", sendKey: keys.sendKey, receiveKey: keys.receiveKey });
    this.sendFrame(JSON.stringify(this.channel.sealText(TRANSPORT_READY_MESSAGE)));
    this.retryFloorMs = 0;
    this.markOnline();
  }

  /** Closes the socket after a handshake that got no usable answer. The next dial waits a minute. */
  private failHandshake(reason: string): void {
    this.dropChannel();
    this.approved = false;
    this.offlineReason = reason;
    this.retryFloorMs = FAILED_HANDSHAKE_RETRY_MS;
    this.failPending(new Error(reason));
    this.hooks.onStatusChange?.();
    this.ws?.close();
  }

  private markOnline(): void {
    this.approved = true;
    this.offlineReason = undefined;
    this.hooks.onStatusChange?.();
    if (this.channel instanceof PeerChannel && this.channel.sessionKeyed) {
      void this.offerLinkSecret();
      return;
    }
    this.hooks.onOnline(this.record);
  }

  /**
   * Moves an existing link to v2 (spec 10.2). The secret is made here, sent
   * over this session-keyed channel, and stored only after the target says
   * it has it. Then the link reconnects with a v2 handshake. A target that
   * does not know the action leaves the link on the old path for now.
   */
  private async offerLinkSecret(): Promise<void> {
    const ws = this.ws;
    const linkSecret = crypto.randomBytes(32).toString("base64");
    let accepted = false;
    try {
      accepted = (await this.request("link_upgrade", { linkSecret }, "", undefined, HANDSHAKE_WAIT_MS)).ok;
    } catch {
      // No answer, or the socket went away. The next connect asks again.
    }
    if (this.ws !== ws || this.closed) return;
    if (!accepted || !this.hooks.saveRecord) {
      this.hooks.onOnline(this.record);
      return;
    }
    this.record = { ...this.record, linkSecret };
    this.hooks.saveRecord(this.record);
    console.log(`[ComputerLinks] ${this.record.name}: link moved to the new transport`);
    this.redial(new Error(`${this.record.name} reconnected on the new transport`));
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
    this.sendFrame(JSON.stringify(message));
  }

  private sendFrame(frame: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  private sendEncrypted(message: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.channel) throw new Error(`${this.record.name} is offline`);
    this.ws.send(JSON.stringify(this.channel.sealText(JSON.stringify(message))));
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
    }, Math.max(this.reconnectDelay, this.retryFloorMs));
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
    private readonly hooks: LinkHooks,
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
    const connection = new LinkConnection(record, this.keyPair, {
      ...this.hooks,
      // A link_upgrade the target accepted. The connection already uses the new record.
      saveRecord: (upgraded) => { this.store.set(upgraded); },
    });
    this.connections.set(record.targetPubkey, connection);
    connection.connect();
    return connection;
  }

  /**
   * Stores a link and connects it. A record with no link secret keeps the
   * one the stored link has: a link that has moved to v2 never goes back.
   */
  set(record: ComputerLinkRecord): ComputerLinkRecord {
    if (!isValidPublicKey(record.targetPubkey)) throw new Error("targetPubkey must be a base64 X25519 key");
    if (record.linkSecret !== undefined && !isValidPublicKey(record.linkSecret)) throw new Error("linkSecret must be base64 of 32 bytes");
    const targetPubkey = normalizePublicKey(record.targetPubkey);
    const linkSecret = record.linkSecret ?? this.store.get(targetPubkey)?.linkSecret;
    const saved = this.store.set({ ...record, targetPubkey, ...(linkSecret ? { linkSecret } : {}) });
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
