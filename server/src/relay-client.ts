import WebSocket from "ws";
import * as nacl from "tweetnacl";
import {
  KeyPair,
  PeerChannel,
  SessionKeyRequiredError,
  SessionKeyedPeerStore,
  acceptKeyExchange,
  isSessionKeyDowngrade,
  type SessionKeyedPeers,
} from "./relay-crypto";
import { parseClientMessage } from "./client-message";
import { errorMessage, isRecord, parseJsonObject } from "./value-guards";
import {
  ClientMessage,
  TransportLane,
  supportsSessionEventAcknowledgement,
  supportsMonitorOutputAcknowledgement,
} from "./protocol";
import { BinaryFileDownloadChunkMetadata, encodeBinaryFileDownloadChunk, supportsBinaryFileDownload } from "./file-transfer-wire";
import { supportsBinaryBrowserFrames } from "./browser-frame-wire";
import type { DeviceAuthOutcome, PeerAdmission, RelayLane } from "./device-auth";
import { STATE_RESET_HINT, type DevicePlatform } from "./device-registry";
import { MAX_HANDSHAKE_FRAME_BYTES, TRANSPORT_VERSION, type TransportChannel } from "./transport-v2";
import type { RelayPushRequest } from "./push-sealing";
import {
  HANDSHAKE_WAIT_MS,
  HELD_PEER_WAIT_MS,
  isTransportReady,
  type AcceptedHandshake,
  type PairingUpdate,
  type TransportResponder,
} from "./transport-responder";

// Binary envelope plaintext markers — first byte of the decrypted payload.
const BIN_MARKER_JSON = 0x4A;          // 'J' — UTF-8 JSON message follows
const BIN_MARKER_UPLOAD_CHUNK = 0x42;  // 'B' — upload chunk: [1 idLen][idBytes][4 chunkIdx BE][bytes]
const LEGACY_PEER_ID = "legacy";
const MAX_PENDING_PEERS = 8;
const PENDING_PEER_TTL_MS = 10 * 60 * 1000;
const messagePeers = new WeakMap<ClientMessage, string>();
const messagePeerKeys = new WeakMap<ClientMessage, string>();
const messageChannels = new WeakMap<ClientMessage, MessageChannelKind>();
// A new-style join the relay refuses with 4004 belongs to another owner key.
const RELAY_CLOSE_OWNER_MISMATCH = 4004;
const OWNER_MISMATCH_RETRY_MS = 10 * 60 * 1000;
// The relay takes a limited number of new room claims per hour from one
// address and closes with 1013 past it. That one means "try again later".
const RELAY_CLOSE_CLAIM_LIMIT = 1013;
const CLAIM_LIMIT_RETRY_MS = 5 * 60 * 1000;
const RELAY_AUTH_LABEL = "socketagent-relay-auth-v1";
/** How long `relayPush` waits for the relay's `relay_push_result`. */
const RELAY_PUSH_WAIT_MS = 10_000;

interface PendingRelayPush {
  resolve: (result: { sent: number; attempted: number }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * How the channel a message arrived on was keyed. `v2` is a transport v2
 * handshake. `session` and `static` are the old path, with and without
 * session keys. `plain` is the loopback token socket.
 */
export type MessageChannelKind = "v2" | "session" | "static" | "plain";

function channelKindOf(channel: PeerChannel | TransportChannel | null): "v2" | "session" | "static" {
  return channel instanceof PeerChannel ? (channel.sessionKeyed ? "session" : "static") : "v2";
}

/** The bytes a computer signs to prove it owns a relay room (wire spec 12.2). */
export function relayAuthMessage(roomId: string, nonce: Uint8Array): Buffer {
  const zero = Uint8Array.of(0);
  return Buffer.concat([Buffer.from(RELAY_AUTH_LABEL, "ascii"), zero, Buffer.from(roomId, "utf8"), zero, nonce]);
}

// A ping tick this much later than scheduled means the event loop stalled.
const PING_STALL_SLACK_MS = 5_000;

/**
 * Pings a socket every interval and reports it dead when a ping goes a whole
 * interval unanswered. After an event-loop stall, timers run before pending
 * socket reads, so the verdict waits for those reads, and a tick that fired
 * late pings again instead of judging a reply it could not have read yet.
 */
export class PingKeepalive {
  private timer: ReturnType<typeof setInterval> | null = null;
  private answered = true;
  private lastPingAt = 0;

  constructor(
    private readonly socket: { readonly readyState: number; ping(): void },
    private readonly intervalMs: number,
    private readonly onDead: () => void,
  ) {}

  start(): void {
    this.stop();
    this.answered = true;
    this.lastPingAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pong(): void {
    this.answered = true;
  }

  private tick(): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const stalled = Date.now() - this.lastPingAt > this.intervalMs + PING_STALL_SLACK_MS;
    setImmediate(() => {
      if (!this.timer || this.socket.readyState !== WebSocket.OPEN) return;
      if (!this.answered && !stalled) {
        this.onDead();
        return;
      }
      this.answered = false;
      this.lastPingAt = Date.now();
      this.socket.ping();
    });
  }
}

/** Routing metadata belongs to the authenticated transport, never the wire payload. */
export function relayPeerForMessage(message: ClientMessage): string | undefined {
  return messagePeers.get(message);
}

/**
 * The recorded device key a message arrived under: every relay message, and
 * a direct socket's once its handshake has proved the key.
 */
export function relayPeerKeyForMessage(message: ClientMessage): string | undefined {
  return messagePeerKeys.get(message);
}

/** How the channel this message arrived on was keyed. Unset means the loopback token socket. */
export function channelKindForMessage(message: ClientMessage): MessageChannelKind {
  return messageChannels.get(message) ?? "plain";
}

/** A direct socket records where its message came from, as the relay client does for its own. */
export function noteDirectMessageOrigin(message: ClientMessage, origin: { publicKey?: string; channel: MessageChannelKind }): void {
  if (origin.publicKey) messagePeerKeys.set(message, origin.publicKey);
  messageChannels.set(message, origin.channel);
}

/**
 * approved: fully open. admitted: its key may use this lane, but nothing has
 * proven it holds the channel yet; the first frame that opens does, and until
 * then it gets nothing and counts as absent, so a key exchange that only names
 * an enrolled key (or replays a recorded one) cannot drain the outbox or pass
 * for the phone. pending: held until device_auth or an approval; it receives
 * nothing but device_auth replies. dropped: ignored until it leaves.
 *
 * A v2 peer uses the same four: admitted from `hs2` until its
 * `transport_ready`, pending while it waits for Allow, then approved.
 */
type RelayPeerAuth = "approved" | "admitted" | "pending" | "dropped";

interface RelayPeer {
  /**
   * Set for good by the peer's first frame: `hs1` makes it a v2 peer,
   * `key_exchange` an old-path one.
   */
  mode: "unknown" | "legacy" | "v2";
  /** A v2 peer's one handshake, once answered. Null when it was refused or silent. */
  handshake: AcceptedHandshake | null;
  /** A v2 peer has spent its one handshake. */
  handshakeUsed: boolean;
  publicKey: Uint8Array | null;
  /** A v2 peer's key is set at `transport_ready`, not before. */
  publicKeyBase64: string | null;
  /** Set by the key exchange or the v2 handshake. */
  channel: PeerChannel | TransportChannel | null;
  auth: RelayPeerAuth;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  binaryEnabled: boolean;
  supportsSessionEventAck: boolean;
  supportsMonitorOutputAck: boolean;
  supportsBinaryFileDownload: boolean;
  supportsBinaryBrowserFrames: boolean;
}

export interface RelayOutboxDrain {
  messages: Record<string, unknown>[];
  droppedMessages: number;
}

/**
 * Bounded FIFO for server events emitted while no encrypted phone peer exists.
 * Short-lived tool cards must survive the relay peer's reconnect/key exchange
 * window; otherwise only their persisted history copy is visible later.
 */
export class RelayMessageOutbox {
  private messages: Array<{
    message: Record<string, unknown>;
    bytes: number;
    coalesceKey?: string;
  }> = [];
  private coalesced = new Map<string, {
    message: Record<string, unknown>;
    bytes: number;
    coalesceKey?: string;
  }>();
  private totalBytes = 0;
  private droppedMessages = 0;

  constructor(
    private readonly maxMessages = 4_000,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  enqueue(message: Record<string, unknown>): void {
    // Raw SDK events are diagnostic and recoverable through the bounded raw
    // history endpoint. Never let them crowd durable chat cards out of the
    // reconnect queue while no phone is attached.
    if (message.type === "sdk_event") return;

    const bytes = Buffer.byteLength(JSON.stringify(message));
    const coalesceKey = this.coalesceKey(message);
    const existing = coalesceKey ? this.coalesced.get(coalesceKey) : undefined;
    if (existing) {
      this.totalBytes += bytes - existing.bytes;
      existing.message = message;
      existing.bytes = bytes;
      this.trim();
      return;
    }

    const queued = { message, bytes, ...(coalesceKey ? { coalesceKey } : {}) };
    this.messages.push(queued);
    if (coalesceKey) this.coalesced.set(coalesceKey, queued);
    this.totalBytes += bytes;
    this.trim();
  }

  private coalesceKey(message: Record<string, unknown>): string | null {
    const type = String(message.type || "");
    if (type !== "text" && type !== "thinking") return null;
    const sessionId = String(message.sessionId || "");
    const identity = String(message.entryId || message.streamId || "");
    return sessionId && identity ? `stream:${sessionId}:${type}:${identity}` : null;
  }

  private trim(): void {
    while (
      this.messages.length > this.maxMessages ||
      this.totalBytes > this.maxBytes
    ) {
      const removed = this.messages.shift();
      if (!removed) break;
      this.totalBytes -= removed.bytes;
      if (removed.coalesceKey && this.coalesced.get(removed.coalesceKey) === removed) {
        this.coalesced.delete(removed.coalesceKey);
      }
      this.droppedMessages++;
    }
  }

  drain(): RelayOutboxDrain {
    const result = {
      messages: this.messages.map((entry) => entry.message),
      droppedMessages: this.droppedMessages,
    };
    this.messages = [];
    this.coalesced.clear();
    this.totalBytes = 0;
    this.droppedMessages = 0;
    return result;
  }

  get length(): number {
    return this.messages.length;
  }
}

export type RelayStatus = "disconnected" | "connecting" | "waiting_for_peer" | "paired" | "error";

/** Decides what a relay peer may do. Index.ts backs this with the device registry. */
export interface RelayPeerAuthorizer {
  authorize(publicKey: string, lane: RelayLane): PeerAdmission;
  deviceAuth(publicKey: string, lane: RelayLane, request: { token?: string; name?: string; platform?: DevicePlatform }): DeviceAuthOutcome;
}

export interface RelayClientOptions {
  relayUrl: string;
  /** The room ID. The name is historical. */
  pairingToken: string;
  keyPair: KeyPair;
  /**
   * The Ed25519 key that proves this computer owns its rooms. `connect`
   * needs it. Tests that never connect leave it out.
   */
  ownerKey?: { publicKey: Uint8Array; secretKey: Uint8Array };
  /** Answers `hs1` from devices, and from linked computers in the link room. Without one, v2 peers get silence. */
  responder?: TransportResponder;
  /** False refuses `key_exchange`, which turns the old path off in this room. Default true. */
  legacyTransport?: boolean;
  lane?: RelayLane;
  /**
   * Without an authorizer every key is approved, which is only right for
   * tests. Index.ts always passes the device registry gate.
   */
  peerAuth?: RelayPeerAuthorizer;
  /**
   * Keys that have used session keys and may no longer fall back to the
   * static box. Shared with the direct socket and the link client so a key
   * proven on one transport is held to it on all. Defaults to memory only.
   */
  sessionKeyedPeers?: SessionKeyedPeers;
  /** A pending key needs approval from an enrolled device. */
  onDevicePending?: (notice: { publicKey: string; name: string; platform: DevicePlatform; code: string }) => void;
  /** A held peer expired or was dropped before approval. */
  onPendingDropped?: (publicKey: string) => void;
  /** An approved peer opened or left. Used by the link lane to track who is online. */
  onPeerOpened?: (peerId: string, publicKey: string) => void;
  onPeerClosed?: (peerId: string, publicKey: string) => void;
  /**
   * Link lane only: decrypted JSON from an approved computer peer, delivered
   * without client-message parsing so peer wire shapes stay out of the phone
   * protocol. `channel` says how the peer's channel was keyed.
   */
  onPeerJson?: (msg: Record<string, unknown>, peerId: string, publicKey: string, channel: "v2" | "session" | "static") => void;
  /**
   * Build the authoritative capability payload for this server. Keeping this
   * in index.ts ensures direct and relay handshakes cannot advertise different
   * feature sets as new capabilities are added.
   */
  serverCapabilities?: (
    binaryEnvelope: boolean,
    lane: TransportLane,
    publicKey: string | null,
    /** 2 for a v2 channel, 1 for the old path. */
    transport: 1 | 2,
  ) => Record<string, unknown>;
  onMessage?: (msg: ClientMessage) => void;
  onStatusChange: (status: RelayStatus) => void;
}

/**
 * Outbound WebSocket connection from server to relay.
 * Auto-reconnects, handles NaCl key exchange with the phone,
 * and encrypts/decrypts all bridged messages.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private peers = new Map<string, RelayPeer>();
  private relaySupportsMultiDevice = false;
  /** The relay accepted this socket as the room's owner. Only then does it take `relay_push`. */
  private ownsRoom = false;
  private refusedAsOwner = false;
  private pendingPushes = new Map<string, PendingRelayPush>();
  private nextPushId = 1;
  private status: RelayStatus = "disconnected";
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private keepalive: PingKeepalive | null = null;
  private outbox = new RelayMessageOutbox();
  private readonly sessionKeyedPeers: SessionKeyedPeers;
  private static PING_INTERVAL = 30_000;  // send ping every 30s

  // Virtual WebSocket interface for ClaudeSession compatibility
  private virtualWs: VirtualRelaySocket;

  constructor(private opts: RelayClientOptions) {
    this.virtualWs = new VirtualRelaySocket(this);
    this.sessionKeyedPeers = opts.sessionKeyedPeers ?? new SessionKeyedPeerStore();
  }

  /** Get a WebSocket-like object that ClaudeSession can use */
  getVirtualSocket(): VirtualRelaySocket {
    return this.virtualWs;
  }

  /** Connect to the relay server */
  connect(): void {
    if (this.closed) return;
    this.setStatus("connecting");

    const ownerKey = this.opts.ownerKey;
    if (!ownerKey) throw new Error("A relay client needs the relay owner key to join its room");
    console.log(`[Relay] Connecting to ${this.opts.relayUrl}...`);

    try {
      // A new-style join (wire spec 12.1): the room ID rides in a header, so
      // it stays out of URLs and the relay's access logs. There is no
      // fallback to the old `?token=` join: once this computer owns its room
      // the relay refuses that join for it.
      this.ws = new WebSocket(this.opts.relayUrl, {
        headers: {
          "X-SocketAgent-Protocol": "2",
          "X-SocketAgent-Role": "server",
          "X-SocketAgent-Room": encodeURIComponent(this.opts.pairingToken),
          "X-SocketAgent-Owner-Key": Buffer.from(ownerKey.publicKey).toString("base64"),
        },
      });
    } catch (err) {
      console.error(`[Relay] Connection error: ${errorMessage(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("upgrade", response => {
      response.socket.setKeepAlive(true, 60_000);
    });

    this.ws.on("open", () => {
      console.log(`[Relay] Connected, waiting for phone...`);
      this.reconnectDelay = 1000; // reset backoff
      this.setStatus("waiting_for_peer");
      this.virtualWs._setOpen(true);

      // Start WebSocket-level ping/pong keepalive
      this.startPingPong();
    });

    this.ws.on("pong", () => {
      this.keepalive?.pong();
    });

    this.ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          this.handleBinaryFrame(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
          return;
        }
        const raw = (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString();
        const parsed: unknown = JSON.parse(raw);
        this.handleRelayMessage(parsed);
      } catch (err) {
        console.error(`[Relay] Failed to parse message: ${errorMessage(err)}`);
      }
    });

    this.ws.on("close", (code) => {
      console.log(`[Relay] Disconnected`);
      if (code === RELAY_CLOSE_OWNER_MISMATCH) {
        this.refusedAsOwner = true;
        this.reconnectDelay = OWNER_MISMATCH_RETRY_MS;
        console.error(`[Relay${this.laneTag()}] Another key owns this relay room, so this computer cannot use it. Trying again in 10 minutes. ${STATE_RESET_HINT}`);
      } else if (code === RELAY_CLOSE_CLAIM_LIMIT) {
        this.reconnectDelay = CLAIM_LIMIT_RETRY_MS;
        console.warn(`[Relay${this.laneTag()}] The relay is taking no new room claims from this address right now. Trying again in 5 minutes.`);
      }
      this.stopPingPong();
      this.ws = null;
      for (const id of Array.from(this.peers.keys())) this.removePeer(id);
      this.virtualWs.supportsSessionEventAck = false;
      this.virtualWs.supportsMonitorOutputAck = false;
      this.virtualWs.supportsRawSdkEvents = false;
      this.relaySupportsMultiDevice = false;
      this.failPendingPushes();
      this.virtualWs._noteTransportReset();
      this.setStatus("disconnected");
      if (!this.closed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error(`[Relay] Error: ${err.message}`);
      // close event will follow
    });
  }

  /**
   * Send a server→client message through the relay (encrypted if paired).
   * `skipPeer` leaves out peers that get this state another way.
   */
  send(msg: Record<string, unknown>, skipPeer?: (peerId: string) => boolean): void {
    const pairedPeers = Array.from(this.peers.entries())
      .filter(([, peer]) => peer.auth === "approved" && peer.publicKey !== null);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || pairedPeers.length === 0) {
      // Link peers never receive the broadcast stream, queued or live.
      if (this.opts.lane !== "link") this.outbox.enqueue(msg);
      return;
    }

    for (const [peerId, peer] of pairedPeers) {
      if (skipPeer?.(peerId)) continue;
      this.sendToPeer(peerId, msg, peer);
    }
  }

  sendReply(peerId: string, message: Record<string, unknown>): void {
    const peer = this.peers.get(peerId);
    // A disconnected request must not be replayed to a different device.
    if (!peer?.publicKey || peer.auth !== "approved" || this.ws?.readyState !== WebSocket.OPEN) return;
    this.sendToPeer(peerId, message, peer);
  }

  /** Sends to every approved peer that authenticated with this key. */
  sendToPeersWithKey(publicKey: string, message: Record<string, unknown>): boolean {
    let sent = false;
    for (const [peerId, peer] of this.peers) {
      if (peer.auth !== "approved" || peer.publicKeyBase64 !== publicKey) continue;
      this.sendToPeer(peerId, message, peer);
      sent = true;
    }
    return sent;
  }

  /** Keys of approved peers currently open on this lane. */
  openPeerKeys(): string[] {
    return Array.from(this.peers.values())
      .filter((peer) => peer.auth === "approved" && peer.publicKeyBase64)
      .map((peer) => peer.publicKeyBase64!);
  }

  isKeyOnline(publicKey: string): boolean {
    return this.openPeerKeys().includes(publicKey);
  }

  /** Whether a held peer with this key is still waiting on this lane. */
  isKeyPending(publicKey: string): boolean {
    return Array.from(this.peers.values()).some((peer) => peer.auth === "pending" && peer.publicKeyBase64 === publicKey);
  }

  /** An enrolled device approved this key: open every peer held under it. */
  approvePeersWithKey(publicKey: string): number {
    let opened = 0;
    for (const [peerId, peer] of this.peers) {
      if (peer.auth !== "pending" || peer.publicKeyBase64 !== publicKey) continue;
      if (peer.handshake) {
        const approved = this.opts.responder?.approve(peer.handshake);
        if (!approved) {
          this.dropPeer(peerId, peer, false);
          continue;
        }
        this.sendToPeer(peerId, { type: "device_auth_result", ok: true }, peer, true);
        this.openV2Peer(peerId, peer, peer.handshake, approved.pairingUpdate);
      } else {
        this.sendToPeer(peerId, { type: "device_auth_result", ok: true }, peer, true);
        this.openPeer(peerId, peer);
      }
      opened++;
    }
    return opened;
  }

  /**
   * Stops talking to every peer under this key. The relay has no server-side
   * kick, so the peer is told once and then ignored until it disconnects.
   * An open v2 peer is told nothing: on v2 `device_auth_result` is only the
   * verdict for a held peer.
   */
  dropPeersWithKey(publicKey: string, reason: "removed" | "not_approved", only?: "legacy"): number {
    let dropped = 0;
    for (const [peerId, peer] of this.peers) {
      if (peer.auth === "dropped" || peer.publicKeyBase64 !== publicKey) continue;
      if (only === "legacy" && peer.mode !== "legacy") continue;
      const wasOpen = peer.auth === "approved";
      if (peer.mode !== "v2" || peer.auth === "pending") {
        this.sendToPeer(peerId, { type: "device_auth_result", ok: false, reason: peer.mode === "v2" ? "not_approved" : reason }, peer, true);
      }
      this.dropPeer(peerId, peer, wasOpen);
      dropped++;
    }
    return dropped;
  }

  /** Sends to every open v2 peer and returns their keys. Used for `pairing_update`. */
  sendToV2Peers(message: Record<string, unknown>): string[] {
    const keys: string[] = [];
    for (const [peerId, peer] of this.peers) {
      if (peer.mode !== "v2" || peer.auth !== "approved" || !peer.publicKeyBase64) continue;
      this.sendToPeer(peerId, message, peer);
      keys.push(peer.publicKeyBase64);
    }
    return keys;
  }

  /** How the open peers under this key are connected. */
  transportOfKey(publicKey: string): 1 | 2 | undefined {
    for (const peer of this.peers.values()) {
      if (peer.auth === "approved" && peer.publicKeyBase64 === publicKey) return peer.mode === "v2" ? 2 : 1;
    }
    return undefined;
  }

  /** Whether the relay is connected and paired with a phone */
  get isPaired(): boolean {
    return this.status === "paired" && this.hasPairedPeer();
  }

  get currentStatus(): RelayStatus {
    return this.status;
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /**
   * Moves to another relay room. Peers in the old room are dropped, and the
   * client reconnects with `pairingToken` right away, also when it was
   * waiting out a refused join.
   */
  moveRoom(pairingToken: string): void {
    this.opts = { ...this.opts, pairingToken };
    this.reconnectDelay = 1000;
    this.refusedAsOwner = false;
    if (this.ws) {
      this.ws.close();
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connect();
  }

  /** The relay's last answer to this room was that another key owns it. */
  get ownerMismatch(): boolean {
    return this.refusedAsOwner;
  }

  /** Disconnect and stop reconnecting */
  close(): void {
    this.closed = true;
    this.stopPingPong();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
    for (const id of Array.from(this.peers.keys())) this.removePeer(id);
    this.virtualWs.supportsSessionEventAck = false;
    this.virtualWs.supportsMonitorOutputAck = false;
    this.virtualWs.supportsRawSdkEvents = false;
    this.relaySupportsMultiDevice = false;
    this.failPendingPushes();
    this.virtualWs._setOpen(false);
    this.setStatus("disconnected");
  }

  /**
   * Asks the relay to send a push to the phones registered for this room
   * (wire spec 11.2). The frame goes over this socket, which already proved
   * the room is this computer's, so there is nothing else to sign. Rejects
   * when the socket is down, when the relay reports an error, and after 10 s
   * with no answer.
   */
  relayPush(push: RelayPushRequest): Promise<{ sent: number; attempted: number }> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ownsRoom) {
      return Promise.reject(new Error("the relay socket is down"));
    }
    const id = `push-${this.nextPushId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPushes.delete(id);
        reject(new Error("the relay did not answer in 10 s"));
      }, RELAY_PUSH_WAIT_MS);
      this.pendingPushes.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "relay_push", id, ...push }));
    });
  }

  /** Settles the push a `relay_push_result` answers. A result for no waiting push is dropped. */
  private handlePushResult(result: Record<string, unknown>): void {
    const { id, error } = result;
    const pending = typeof id === "string" ? this.pendingPushes.get(id) : undefined;
    if (!pending || typeof id !== "string") return;
    this.pendingPushes.delete(id);
    clearTimeout(pending.timer);
    if (error !== undefined) {
      // `invalid_push`: the relay could not use the frame. `send_failed`: Firebase failed.
      const known = error === "invalid_push" || error === "send_failed";
      pending.reject(new Error(`the relay answered ${known ? error : "an unknown error"}`));
      return;
    }
    const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
    pending.resolve({ sent: count(result.sent), attempted: count(result.attempted) });
  }

  private failPendingPushes(): void {
    this.ownsRoom = false;
    for (const pending of this.pendingPushes.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("the relay socket closed"));
    }
    this.pendingPushes.clear();
  }

  private getPeer(peerId = LEGACY_PEER_ID): RelayPeer {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = {
        mode: "unknown",
        handshake: null,
        handshakeUsed: false,
        publicKey: null,
        publicKeyBase64: null,
        channel: null,
        // Admitted at key exchange when the gate (or its absence) allows the
        // key; open once its first frame proves it holds the channel.
        auth: "pending",
        pendingTimer: null,
        binaryEnabled: false,
        supportsSessionEventAck: false,
        supportsMonitorOutputAck: false,
        supportsBinaryFileDownload: false,
        supportsBinaryBrowserFrames: false,
      };
      this.peers.set(peerId, peer);
    }
    return peer;
  }

  private hasPairedPeer(): boolean {
    return Array.from(this.peers.values()).some((peer) => peer.auth === "approved" && peer.publicKey !== null);
  }

  private pendingPeerCount(): number {
    return Array.from(this.peers.values()).filter((peer) => peer.auth === "pending" && peer.publicKey !== null).length;
  }

  private clearPendingTimer(peer: RelayPeer): void {
    if (peer.pendingTimer) clearTimeout(peer.pendingTimer);
    peer.pendingTimer = null;
  }

  private removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.clearPendingTimer(peer);
    this.peers.delete(peerId);
    if (peer.handshake) this.opts.responder?.release(peer.handshake);
    if (peer.auth === "approved" && peer.publicKeyBase64) {
      this.opts.onPeerClosed?.(peerId, peer.publicKeyBase64);
    } else if (peer.auth === "pending" && peer.publicKeyBase64) {
      this.opts.onPendingDropped?.(peer.publicKeyBase64);
    }
  }

  private dropPeer(peerId: string, peer: RelayPeer, wasOpen: boolean): void {
    const key = peer.publicKeyBase64;
    const wasApproved = peer.auth === "approved";
    const wasHeld = peer.auth === "pending" && peer.mode === "v2";
    this.clearPendingTimer(peer);
    if (peer.handshake) this.opts.responder?.release(peer.handshake);
    peer.auth = "dropped";
    if (wasHeld && key) this.opts.onPendingDropped?.(key);
    if (wasApproved && key) this.opts.onPeerClosed?.(peerId, key);
    if (wasApproved) this.recomputePeerCapabilities();
    if (wasOpen && !this.hasPairedPeer()) {
      this.virtualWs.supportsRawSdkEvents = false;
      this.virtualWs._noteTransportReset();
      this.setStatus("waiting_for_peer");
    }
  }

  private recomputePeerCapabilities(): void {
    const open = Array.from(this.peers.values()).filter((peer) => peer.auth === "approved");
    this.virtualWs.supportsSessionEventAck = open.some((peer) => peer.supportsSessionEventAck);
    this.virtualWs.supportsMonitorOutputAck = open.length > 0 && open.every((peer) => peer.supportsMonitorOutputAck);
  }

  /** An admitted or held peer becomes a normal peer: open the lane, replay the outbox. */
  private openPeer(peerId: string, peer: RelayPeer): void {
    this.clearPendingTimer(peer);
    peer.auth = "approved";
    this.virtualWs._setOpen(true);
    this.setStatus("paired");
    console.log(`[Relay${this.laneTag()}] Peer ${peerId} open`);
    this.flushOutboxToPeer(peerId, peer);
    if (peer.publicKeyBase64) this.opts.onPeerOpened?.(peerId, peer.publicKeyBase64);
  }

  private laneTag(): string {
    return this.opts.lane && this.opts.lane !== "control" ? `:${this.opts.lane}` : "";
  }

  private handleDeviceAuth(peerId: string, peer: RelayPeer, msg: ClientMessage & { type: "device_auth" }): void {
    if (!peer.publicKeyBase64) return;
    if (!this.opts.peerAuth) {
      this.sendToPeer(peerId, { type: "device_auth_result", ok: true }, peer, true);
      if (peer.auth === "pending") this.openPeer(peerId, peer);
      return;
    }
    const outcome = this.opts.peerAuth.deviceAuth(peer.publicKeyBase64, this.opts.lane || "control", {
      token: msg.token, name: msg.name, platform: msg.platform,
    });
    if (outcome.ok) {
      this.sendToPeer(peerId, { type: "device_auth_result", ok: true }, peer, true);
      if (peer.auth === "pending") this.openPeer(peerId, peer);
      return;
    }
    this.sendToPeer(peerId, {
      type: "device_auth_result", ok: false, reason: outcome.reason,
      ...(outcome.code ? { code: outcome.code } : {}),
    }, peer, true);
    if (outcome.notify && peer.auth === "pending") this.opts.onDevicePending?.(outcome.notify);
    if (outcome.close) this.dropPeer(peerId, peer, false);
  }

  private sendRawFrameToPeer(peerId: string, data: string | Buffer, binary: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.relaySupportsMultiDevice) {
      this.ws.send(JSON.stringify({
        type: "relay_to_peer",
        peerId,
        binary,
        data: binary ? Buffer.from(data).toString("base64") : data.toString(),
      }));
      return;
    }

    this.ws.send(data, { binary });
  }

  private sendPlainToPeer(peerId: string, msg: Record<string, unknown>): void {
    this.sendRawFrameToPeer(peerId, JSON.stringify(msg), false);
  }

  private sendToPeer(peerId: string, msg: Record<string, unknown>, peer = this.getPeer(peerId), allowHeld = false): void {
    const channel = peer.channel;
    if (!channel) return;
    // A held peer gets device_auth replies and nothing else.
    if (peer.auth !== "approved" && !allowHeld) return;
    // A session nonce is spent once sealed, so seal only what will be sent.
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const json = JSON.stringify(msg);
    if (peer.binaryEnabled) {
      const jsonBytes = new TextEncoder().encode(json);
      const plaintext = new Uint8Array(jsonBytes.length + 1);
      plaintext[0] = BIN_MARKER_JSON;
      plaintext.set(jsonBytes, 1);
      this.sendRawFrameToPeer(peerId, channel.sealBinary(plaintext), true);
    } else {
      this.sendRawFrameToPeer(peerId, JSON.stringify(channel.sealText(json)), false);
    }
  }

  supportsBinaryFileDownloads(peerId?: string): boolean {
    if (peerId) return this.getPeer(peerId).supportsBinaryFileDownload;
    return Array.from(this.peers.values()).some((peer) => peer.auth === "approved" && peer.supportsBinaryFileDownload);
  }

  sendFileDownloadChunk(
    metadata: BinaryFileDownloadChunkMetadata,
    bytes: Buffer,
    peerId?: string,
  ): boolean {
    const targets = peerId
      ? [[peerId, this.getPeer(peerId)] as const]
      : Array.from(this.peers.entries());
    if (targets.length === 0 || targets.some(([, peer]) =>
      peer.auth !== "approved" || !peer.channel || !peer.binaryEnabled || !peer.supportsBinaryFileDownload
    )) {
      return false;
    }
    if (this.ws?.readyState !== WebSocket.OPEN) return true;
    const plaintext = encodeBinaryFileDownloadChunk(metadata, bytes);
    for (const [targetPeerId, peer] of targets) {
      if (peer.channel) this.sendRawFrameToPeer(targetPeerId, peer.channel.sealBinary(plaintext), true);
    }
    return true;
  }

  /** Send an encoded browser frame to one phone, if it reads binary frames. */
  sendBinaryBrowserFrame(encoded: Buffer, peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer?.channel || peer.auth !== "approved" || !peer.binaryEnabled || !peer.supportsBinaryBrowserFrames) return false;
    if (this.ws?.readyState !== WebSocket.OPEN) return true;
    this.sendRawFrameToPeer(peerId, peer.channel.sealBinary(encoded), true);
    return true;
  }

  private handleRelayMessage(parsed: unknown): void {
    if (!isRecord(parsed)) throw new Error("Invalid relay control message");
    if (parsed.type === "relay_capabilities") {
      this.relaySupportsMultiDevice = !!parsed.multiDevice;
      this.ownsRoom = parsed.owner === true;
      if (this.ownsRoom) this.refusedAsOwner = false;
      if (this.relaySupportsMultiDevice) {
        console.log(`[Relay] Relay supports multi-device routing`);
      }
      return;
    }

    if (parsed.type === "relay_push_result") {
      this.handlePushResult(parsed);
      return;
    }

    // The relay asks this computer to prove it owns the room (wire spec 12.2).
    if (parsed.type === "relay_challenge") {
      const nonce = typeof parsed.nonce === "string" ? Buffer.from(parsed.nonce, "base64") : null;
      const ownerKey = this.opts.ownerKey;
      if (!nonce || nonce.length !== 32 || !ownerKey) return;
      const signature = nacl.sign.detached(relayAuthMessage(this.opts.pairingToken, nonce), ownerKey.secretKey);
      this.ws?.send(JSON.stringify({ type: "relay_auth", sig: Buffer.from(signature).toString("base64") }));
      return;
    }

    if (parsed.type === "relay_error") {
      console.error(`[Relay${this.laneTag()}] The relay refused this computer: ${typeof parsed.error === "string" ? parsed.error : "unknown error"}`);
      return;
    }

    // Relay control messages (unencrypted)
    if (parsed.type === "peer_connected") {
      const peerId = typeof parsed.peerId === "string" ? parsed.peerId : LEGACY_PEER_ID;
      this.getPeer(peerId);
      console.log(`[Relay] Phone connected to relay${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
      if (!this.hasPairedPeer()) {
        this.setStatus("waiting_for_peer");
      }
      return;
    }

    if (parsed.type === "peer_disconnected") {
      const peerId = typeof parsed.peerId === "string" ? parsed.peerId : undefined;
      if (peerId) {
        this.removePeer(peerId);
        console.log(`[Relay] Phone disconnected from relay (${peerId})`);
      } else {
        for (const id of Array.from(this.peers.keys())) this.removePeer(id);
        console.log(`[Relay] Phone disconnected from relay`);
      }
      const stillPaired = this.hasPairedPeer();
      this.recomputePeerCapabilities();
      if (!stillPaired) {
        this.virtualWs.supportsRawSdkEvents = false;
        this.virtualWs._noteTransportReset();
      }
      if (!stillPaired) this.setStatus("waiting_for_peer");
      return;
    }

    if (parsed.type === "relay_peer_message") {
      const peerId = typeof parsed.peerId === "string" ? parsed.peerId : LEGACY_PEER_ID;
      if (parsed.binary) {
        this.handleBinaryFrame(Buffer.from(String(parsed.data || ""), "base64"), peerId);
        return;
      }
      try {
        this.handlePeerText(String(parsed.data || ""), peerId);
      } catch (err) {
        console.error(`[Relay] Failed to parse peer message: ${errorMessage(err)}`);
      }
      return;
    }

    this.handlePeerMessage(parsed, LEGACY_PEER_ID);
  }

  /**
   * A text frame from one peer, as the relay delivered it. The peer's first
   * frame decides what it is for good: `hs1` makes it a v2 peer and
   * `key_exchange` an old-path one.
   */
  private handlePeerText(raw: string, peerId: string): void {
    const peer = this.getPeer(peerId);
    if (peer.mode === "v2") {
      this.handleV2Text(raw, peerId, peer);
      return;
    }
    // A peer with no channel can only send one of the two openers, and both
    // are small. Anything bigger is dropped before it is parsed.
    if (!peer.channel && Buffer.byteLength(raw, "utf8") > MAX_HANDSHAKE_FRAME_BYTES) return;
    const parsed: unknown = JSON.parse(raw);
    if (peer.mode === "unknown" && isRecord(parsed) && parsed.type === "hs1") {
      // A version this side does not speak is ignored and spends nothing.
      if (parsed.v !== TRANSPORT_VERSION) return;
      peer.mode = "v2";
      this.handleV2Text(raw, peerId, peer);
      return;
    }
    this.handlePeerMessage(parsed, peerId);
  }

  /** Stops answering a v2 peer. The app notices on its own and dials again. */
  private dropV2Peer(peerId: string, peer: RelayPeer, why: string): void {
    console.warn(`[Relay${this.laneTag()}] Dropping peer ${peerId}: ${why}`);
    this.dropPeer(peerId, peer, peer.auth === "approved");
  }

  /**
   * A text frame from a v2 peer. Before the handshake the only frame that
   * counts is its one `hs1`. After it, only sealed records do: any other
   * frame, and any record that does not open, drops the peer (spec 4.3).
   */
  private handleV2Text(raw: string, peerId: string, peer: RelayPeer): void {
    if (peer.auth === "dropped") return;
    if (!peer.handshake) {
      // A second hs1, or anything after an hs1 that got no channel, is ignored.
      if (peer.handshakeUsed) return;
      peer.handshakeUsed = true;
      const lane = this.opts.lane || "control";
      const outcome = this.opts.responder?.handleHs1(raw, { path: "relay", lane }) ?? { result: "silent" };
      if (outcome.result === "silent") {
        peer.auth = "dropped";
        return;
      }
      this.sendRawFrameToPeer(peerId, outcome.hs2, false);
      if (outcome.result === "refused") {
        peer.auth = "dropped";
        return;
      }
      const handshake = outcome.handshake;
      peer.handshake = handshake;
      peer.channel = handshake.channel;
      // Nothing is sent or stored until the first record proves the peer
      // holds this handshake's keys.
      peer.auth = "admitted";
      peer.pendingTimer = setTimeout(() => {
        if (peer.auth === "admitted") this.dropV2Peer(peerId, peer, "no transport_ready within 10 s");
      }, HANDSHAKE_WAIT_MS);
      peer.pendingTimer.unref?.();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.dropV2Peer(peerId, peer, "unsealed frame after the handshake");
      return;
    }
    if (isRecord(parsed) && parsed.type === "hs1") return;
    if (!isRecord(parsed) || typeof parsed.n !== "string" || typeof parsed.c !== "string") {
      this.dropV2Peer(peerId, peer, "unsealed frame after the handshake");
      return;
    }
    let plaintext: string;
    try {
      plaintext = peer.handshake.channel.openText({ n: parsed.n, c: parsed.c });
    } catch (err) {
      this.dropV2Peer(peerId, peer, errorMessage(err));
      return;
    }
    if (peer.auth === "admitted") {
      if (isTransportReady(plaintext)) this.handleTransportReady(peerId, peer, peer.handshake);
      else this.dropV2Peer(peerId, peer, "first record was not transport_ready");
      return;
    }
    // A held peer's records are ignored until a paired device answers.
    if (peer.auth !== "approved") return;
    this.routeDecryptedJson(JSON.parse(plaintext), peerId, peer);
  }

  /**
   * The peer proved it holds the handshake's keys. Only now may anything be
   * stored or sent (spec 3.7), and the responder does the storing.
   */
  private handleTransportReady(peerId: string, peer: RelayPeer, handshake: AcceptedHandshake): void {
    this.clearPendingTimer(peer);
    const outcome = this.opts.responder?.ready(handshake) ?? { result: "closed" };
    if (outcome.result === "closed") {
      this.dropV2Peer(peerId, peer, "the handshake no longer matches the stored state");
      return;
    }
    peer.publicKey = new Uint8Array(Buffer.from(handshake.publicKey, "base64"));
    peer.publicKeyBase64 = handshake.publicKey;
    if (outcome.result === "open") {
      this.openV2Peer(peerId, peer, handshake, outcome.pairingUpdate);
      return;
    }
    peer.auth = "pending";
    peer.pendingTimer = setTimeout(() => {
      if (peer.auth !== "pending") return;
      console.log(`[Relay${this.laneTag()}] Held peer ${peerId} was not answered in time`);
      this.sendToPeer(peerId, { type: "device_auth_result", ok: false, reason: "not_approved" }, peer, true);
      this.dropPeer(peerId, peer, false);
    }, HELD_PEER_WAIT_MS);
    peer.pendingTimer.unref?.();
    console.log(`[Relay${this.laneTag()}] Peer ${peerId} held pending device approval`);
    this.opts.onDevicePending?.(outcome.notice);
  }

  /**
   * Opens a v2 peer. Its capabilities came in the handshake, so the first
   * records are `pairing_update` when one is due, then `server_capabilities`,
   * then whatever queued while no device was there.
   */
  private openV2Peer(peerId: string, peer: RelayPeer, handshake: AcceptedHandshake, pairingUpdate?: PairingUpdate): void {
    const caps = handshake.caps;
    peer.binaryEnabled = caps.binaryEnvelope === true;
    peer.supportsSessionEventAck = supportsSessionEventAcknowledgement(caps);
    peer.supportsMonitorOutputAck = supportsMonitorOutputAcknowledgement(caps);
    peer.supportsBinaryFileDownload = supportsBinaryFileDownload(caps);
    peer.supportsBinaryBrowserFrames = supportsBinaryBrowserFrames(caps);
    if (pairingUpdate) this.sendToPeer(peerId, { ...pairingUpdate }, peer, true);
    const lane: TransportLane = this.opts.lane === "bulk" ? "bulk" : "control";
    if (this.opts.serverCapabilities) {
      this.sendToPeer(peerId, this.opts.serverCapabilities(peer.binaryEnabled, lane, handshake.publicKey, 2), peer, true);
    }
    this.openPeer(peerId, peer);
    this.recomputePeerCapabilities();
  }

  private handlePeerMessage(parsed: unknown, peerId: string): void {
    if (!isRecord(parsed)) throw new Error("Invalid relay peer message");
    const peer = this.getPeer(peerId);

    // Key exchange (plaintext from phone)
    if (parsed.type === "key_exchange") {
      if (this.opts.legacyTransport === false) {
        // The old path is off: no ack, and nothing else from this peer counts.
        peer.mode = "legacy";
        peer.channel = null;
        peer.auth = "dropped";
        return;
      }
      peer.mode = "legacy";
      console.log(`[Relay${this.laneTag()}] Received peer public key${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
      let exchange: ReturnType<typeof acceptKeyExchange>;
      try {
        exchange = acceptKeyExchange(parsed, this.opts.keyPair, this.sessionKeyedPeers);
      } catch (err) {
        // A refused exchange leaves the peer unable to send or receive
        // anything until it leaves or tries again.
        if (peer.auth === "approved") this.dropPeer(peerId, peer, true);
        peer.channel = null;
        if (err instanceof SessionKeyRequiredError) {
          console.warn(`[Relay${this.laneTag()}] Refused peer ${peerId}: its key used session keys before, this exchange has none`);
          return;
        }
        throw err;
      }
      const nextKeyBase64 = exchange.peerPublicKeyBase64;
      if (peer.publicKey && peer.publicKeyBase64 !== nextKeyBase64) {
        console.warn(`[Relay] Phone ${peerId} changed public key; replacing peer crypto state`);
        if (peer.auth === "approved") this.dropPeer(peerId, peer, true);
      }
      this.clearPendingTimer(peer);
      peer.publicKey = exchange.peerPublicKey;
      peer.publicKeyBase64 = nextKeyBase64;
      peer.channel = exchange.channel;
      const lane = this.opts.lane || "control";
      const admission: PeerAdmission = this.opts.peerAuth ? this.opts.peerAuth.authorize(nextKeyBase64, lane) : { admission: "approved" };
      const sessionNote = exchange.channel.sessionKeyed ? "session key" : "static key";

      if (admission.admission === "approved") {
        // Send ack PLAINTEXT. The phone needs this to confirm the handshake
        // before encrypted mode begins. Its session key is public. The peer
        // opens on its first frame: a session offer can be replayed and a
        // static-box exchange is only a claim, so the exchange alone proves
        // nothing about who is on the other end.
        if (peer.auth !== "approved") peer.auth = "admitted";
        this.sendPlainToPeer(peerId, { type: "key_exchange_ack", device: "approved", ...exchange.ack });
        console.log(`[Relay${this.laneTag()}] Key exchange complete (${sessionNote}); waiting for the peer's first frame`);
        return;
      }

      // Held or refused peers get the same plaintext ack so the app knows to
      // authenticate, then an encrypted reason when there is nothing to wait for.
      this.sendPlainToPeer(peerId, { type: "key_exchange_ack", device: "pending", ...exchange.ack });
      if (admission.admission === "refused") {
        if (peer.auth === "approved") this.dropPeer(peerId, peer, true);
        peer.auth = "pending";
        this.sendToPeer(peerId, { type: "device_auth_result", ok: false, reason: admission.reason }, peer, true);
        peer.auth = "dropped";
        console.warn(`[Relay${this.laneTag()}] Refused peer ${peerId}: ${admission.reason}`);
        return;
      }
      if (this.pendingPeerCount() >= MAX_PENDING_PEERS) {
        peer.auth = "pending";
        this.sendToPeer(peerId, { type: "device_auth_result", ok: false, reason: "too_many_pending" }, peer, true);
        peer.auth = "dropped";
        console.warn(`[Relay${this.laneTag()}] Too many pending peers, dropping ${peerId}`);
        return;
      }
      peer.auth = "pending";
      peer.pendingTimer = setTimeout(() => {
        if (peer.auth !== "pending") return;
        console.log(`[Relay${this.laneTag()}] Pending peer ${peerId} expired`);
        this.dropPeer(peerId, peer, false);
        if (peer.publicKeyBase64) this.opts.onPendingDropped?.(peer.publicKeyBase64);
      }, PENDING_PEER_TTL_MS);
      peer.pendingTimer.unref?.();
      console.log(`[Relay${this.laneTag()}] Peer ${peerId} held pending device approval`);
      return;
    }

    // Encrypted message from phone
    if (typeof parsed.n === "string" && typeof parsed.c === "string") {
      if (!peer.channel) {
        console.error(`[Relay] Received encrypted message before key exchange${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
        return;
      }
      if (peer.auth === "dropped") return;
      try {
        const plaintext = peer.channel.openText({ n: parsed.n, c: parsed.c });
        this.routeDecryptedJson(JSON.parse(plaintext), peerId, peer);
      } catch (err) {
        console.error(`[Relay] Decryption failed${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}: ${errorMessage(err)}`);
      }
      return;
    }

    // After a key exchange only sealed frames count. The released app sends
    // nothing else unsealed but a repeated key_exchange, handled above.
    if (peer.channel && peer.auth !== "dropped") {
      console.warn(`[Relay${this.laneTag()}] Dropping peer ${peerId}: unsealed frame after the key exchange`);
      this.dropPeer(peerId, peer, peer.auth === "approved");
      return;
    }
    console.warn(`[Relay] Unknown message type: ${typeof parsed.type === "string" ? parsed.type : "no type"}`);
  }

  /**
   * Decrypted JSON from a peer. Held peers may only authenticate. Link peers
   * bypass client-message parsing and go to the peer API.
   */
  private routeDecryptedJson(parsed: unknown, peerId: string, peer: RelayPeer): void {
    if (peer.auth === "dropped") return;
    if (peer.auth === "admitted") this.openPeer(peerId, peer);
    if (this.opts.onPeerJson) {
      if (peer.auth !== "approved" || !peer.publicKeyBase64) return;
      if (!isRecord(parsed)) throw new Error("Invalid peer message");
      this.opts.onPeerJson(parsed, peerId, peer.publicKeyBase64, channelKindOf(peer.channel));
      return;
    }
    const msg = parseClientMessage(parsed);
    if (peer.mode === "v2") {
      // The handshake carried what these did. On v2 they are never sent, and
      // the token in device_auth must not reach the old gate from here.
      if (msg.type === "device_auth" || msg.type === "direct_auth" || msg.type === "client_capabilities") return;
      this.dispatchClientMessage(msg, peerId);
      return;
    }
    if (msg.type === "device_auth") {
      this.handleDeviceAuth(peerId, peer, msg);
      return;
    }
    if (peer.auth !== "approved") {
      this.sendToPeer(peerId, { type: "device_auth_result", ok: false, reason: "not_approved" }, peer, true);
      return;
    }
    this.dispatchClientMessage(msg, peerId);
  }

  /**
   * Decrypt a binary frame and route the plaintext payload. Plaintext is
   * `[1-byte marker][rest]`; the marker tells us whether `rest` is UTF-8 JSON
   * or a packed upload-chunk record.
   */
  private handleBinaryFrame(buf: Buffer, peerId = LEGACY_PEER_ID): void {
    const peer = this.getPeer(peerId);
    if (peer.auth === "dropped") return;
    if (!peer.channel) {
      if (peer.mode === "v2") this.dropV2Peer(peerId, peer, "binary frame before the handshake finished");
      else console.error(`[Relay] Binary frame received before key exchange — dropping${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
      return;
    }
    let plaintext: Uint8Array;
    try {
      plaintext = peer.channel.openBinary(buf);
    } catch (err) {
      if (peer.mode === "v2") this.dropV2Peer(peerId, peer, errorMessage(err));
      else console.error(`[Relay] Binary decryption failed${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}: ${errorMessage(err)}`);
      return;
    }
    if (peer.mode === "v2") {
      // The first record is transport_ready, which is text. A held peer's records are ignored.
      if (peer.auth === "admitted") this.dropV2Peer(peerId, peer, "first record was not transport_ready");
      if (peer.auth !== "approved") return;
    } else if (peer.auth === "admitted") {
      this.openPeer(peerId, peer);
    }
    if (plaintext.length === 0) return;
    const marker = plaintext[0];

    if (marker === BIN_MARKER_JSON) {
      try {
        const json = new TextDecoder().decode(plaintext.subarray(1));
        this.routeDecryptedJson(JSON.parse(json), peerId, peer);
      } catch (err) {
        console.error(`[Relay] Binary JSON parse failed: ${errorMessage(err)}`);
      }
      return;
    }

    if (peer.auth !== "approved") {
      this.sendToPeer(peerId, { type: "device_auth_result", ok: false, reason: "not_approved" }, peer, true);
      return;
    }

    if (marker === BIN_MARKER_UPLOAD_CHUNK) {
      // [1 marker][1 idLen][N idBytes][4 chunkIdx BE][bytes...]
      if (plaintext.length < 6) return;
      const idLen = plaintext[1];
      const headerEnd = 2 + idLen + 4;
      if (plaintext.length < headerEnd) return;
      const uploadId = new TextDecoder().decode(plaintext.subarray(2, 2 + idLen));
      const off = 2 + idLen;
      const chunkIndex =
        ((plaintext[off] << 24) >>> 0) |
        (plaintext[off + 1] << 16) |
        (plaintext[off + 2] << 8) |
        plaintext[off + 3];
      const data = Buffer.from(plaintext.subarray(headerEnd));
      this.dispatchClientMessage({
        type: "upload_chunk_bin",
        uploadId,
        chunkIndex,
        data,
      }, peerId);
      return;
    }

    console.warn(`[Relay] Unknown binary marker: 0x${marker.toString(16)}`);
  }

  /**
   * Dispatch a decrypted client message. Intercepts the wire-format capability
   * handshake so the rest of the server never sees it; everything else goes
   * through to the handler.
   */
  private dispatchClientMessage(msg: ClientMessage, peerId = LEGACY_PEER_ID): void {
    if (msg.type === "client_capabilities") {
      const wantsBinary = msg.binaryEnvelope === true;
      const peer = this.getPeer(peerId);
      if (peer.channel instanceof PeerChannel && isSessionKeyDowngrade(msg, peer.channel)) {
        // Both sides speak session keys but the handshake carried none, so
        // something between them removed it. Hold the key to session keys
        // from now on and stop talking on this channel.
        console.warn(`[Relay${this.laneTag()}] Peer ${peerId} supports session keys but its handshake had none; dropping it`);
        if (peer.publicKeyBase64) this.sessionKeyedPeers.add(peer.publicKeyBase64);
        this.dropPeer(peerId, peer, true);
        return;
      }
      peer.supportsSessionEventAck = supportsSessionEventAcknowledgement(msg);
      peer.supportsMonitorOutputAck = supportsMonitorOutputAcknowledgement(msg);
      peer.supportsBinaryFileDownload = supportsBinaryFileDownload(msg);
      peer.supportsBinaryBrowserFrames = supportsBinaryBrowserFrames(msg);
      this.recomputePeerCapabilities();
      if (wantsBinary && !peer.binaryEnabled) {
        peer.binaryEnabled = true;
        console.log(`[Relay] Phone announced binary envelope support — flipping outbound to binary${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
      }
      // Ack so the phone knows the server is now sending binary. Use the same
      // authoritative payload as direct WebSocket clients; a separately
      // maintained relay payload previously omitted sessionTransfer and made
      // fully updated relay-connected servers appear too old to teleport.
      const lane: TransportLane = this.opts.lane === "bulk" ? "bulk" : "control";
      if (this.opts.serverCapabilities) {
        this.sendToPeer(peerId, this.opts.serverCapabilities(peer.binaryEnabled, lane, peer.publicKeyBase64, 1), peer);
      }
      return;
    }
    messagePeers.set(msg, peerId);
    const peer = this.getPeer(peerId);
    if (peer.publicKeyBase64) messagePeerKeys.set(msg, peer.publicKeyBase64);
    messageChannels.set(msg, channelKindOf(peer.channel));
    this.opts.onMessage?.(msg);
  }

  private setStatus(status: RelayStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatusChange(status);
  }

  private flushOutboxToPeer(peerId: string, peer: RelayPeer): void {
    const pending = this.outbox.drain();
    if (pending.droppedMessages > 0) {
      this.sendToPeer(peerId, {
        type: "history_resync_required",
        reason: "relay_outbox_overflow",
        droppedMessages: pending.droppedMessages,
      }, peer);
    }
    for (const message of pending.messages) {
      this.sendToPeer(peerId, message, peer);
    }
    if (pending.messages.length > 0 || pending.droppedMessages > 0) {
      console.log(
        `[Relay] Replayed ${pending.messages.length} queued message(s)` +
        (pending.droppedMessages > 0
          ? ` after dropping ${pending.droppedMessages} oldest message(s)`
          : ""),
      );
    }
  }

  /** Start periodic WebSocket ping/pong to detect dead connections */
  private startPingPong(): void {
    this.stopPingPong();
    const ws = this.ws;
    if (!ws) return;
    this.keepalive = new PingKeepalive(ws, RelayClient.PING_INTERVAL, () => {
      console.warn(`[Relay] No pong received in ${RelayClient.PING_INTERVAL / 1000}s — forcing reconnect`);
      ws.terminate(); // force-close, triggers 'close' event → scheduleReconnect
    });
    this.keepalive.start();
  }

  private stopPingPong(): void {
    this.keepalive?.stop();
    this.keepalive = null;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.setStatus("disconnected");
    console.log(`[Relay] Reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    // Exponential backoff: 1s → 2s → 4s → ... → 30s max
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}

/**
 * WebSocket-like wrapper that makes the relay connection compatible
 * with ClaudeSession's existing ws interface (readyState + send).
 */
export class VirtualRelaySocket {
  // This is a logical, buffered transport. It remains writable while the
  // relay or phone peer reconnects so running sessions do not detach and lose
  // transient events before the app can issue resume_session.
  readyState: number = WebSocket.OPEN;
  connectionGeneration = 0;
  supportsSessionEventAck = false;
  supportsMonitorOutputAck = false;
  supportsRawSdkEvents = false;
  private _onMessageCallbacks: ((data: Buffer) => void)[] = [];
  private _onCloseCallbacks: (() => void)[] = [];

  constructor(private relay: RelayClient) {}

  get bufferedAmount(): number {
    return this.relay.bufferedAmount;
  }

  supportsBinaryFileDownload(peerId?: string): boolean {
    return this.relay.supportsBinaryFileDownloads(peerId);
  }

  sendFileDownloadChunk(
    metadata: BinaryFileDownloadChunkMetadata,
    bytes: Buffer,
    peerId?: string,
  ): boolean {
    return this.relay.sendFileDownloadChunk(metadata, bytes, peerId);
  }

  sendBinaryBrowserFrame(encoded: Buffer, peerId?: string): boolean {
    return peerId ? this.relay.sendBinaryBrowserFrame(encoded, peerId) : false;
  }

  send(data: string): void {
    try {
      const msg = parseJsonObject(data);
      this.relay.send(msg);
    } catch {
      // If it's not JSON, send raw
      this.relay.send({ raw: data });
    }
  }

  sendReply(peerId: string, data: string): void {
    this.relay.sendReply(peerId, parseJsonObject(data));
  }

  /** Broadcasts a JSON message to every peer except those `skipPeer` names. */
  sendExcept(data: string, skipPeer: (peerId: string) => boolean): void {
    this.relay.send(parseJsonObject(data), skipPeer);
  }

  /** Called by RelayClient when pairing status changes */
  _setOpen(open: boolean): void {
    const wasOpen = this.readyState === WebSocket.OPEN;
    const nextReadyState = open ? WebSocket.OPEN : WebSocket.CLOSED;
    if (this.readyState !== nextReadyState) {
      this.connectionGeneration++;
    }
    this.readyState = nextReadyState;
    if (wasOpen && !open) {
      for (const cb of this._onCloseCallbacks) cb();
    }
  }

  _noteTransportReset(): void {
    this.connectionGeneration++;
  }

  /** Deliver an incoming message (from relay) to anyone listening */
  _deliverMessage(data: string): void {
    for (const cb of this._onMessageCallbacks) {
      cb(Buffer.from(data));
    }
  }

  // Minimal EventEmitter-like interface for compatibility
  on(...args: [event: "message", cb: (data: Buffer) => void] | [event: "close", cb: () => void]): void {
    if (args[0] === "message") this._onMessageCallbacks.push(args[1]);
    else this._onCloseCallbacks.push(args[1]);
  }
}
