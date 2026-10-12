import WebSocket from "ws";
import { KeyPair, encrypt, decrypt, encryptBinary, decryptBinary, toBase64, fromBase64 } from "./relay-crypto";
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
import type { DevicePlatform } from "./device-registry";

// Binary envelope plaintext markers — first byte of the decrypted payload.
const BIN_MARKER_JSON = 0x4A;          // 'J' — UTF-8 JSON message follows
const BIN_MARKER_UPLOAD_CHUNK = 0x42;  // 'B' — upload chunk: [1 idLen][idBytes][4 chunkIdx BE][bytes]
const LEGACY_PEER_ID = "legacy";
const MAX_PENDING_PEERS = 8;
const PENDING_PEER_TTL_MS = 10 * 60 * 1000;
const messagePeers = new WeakMap<ClientMessage, string>();
const messagePeerKeys = new WeakMap<ClientMessage, string>();

/** Routing metadata belongs to the authenticated transport, never the wire payload. */
export function relayPeerForMessage(message: ClientMessage): string | undefined {
  return messagePeers.get(message);
}

/** The enrolled device key a relay message arrived under. Absent on direct sockets. */
export function relayPeerKeyForMessage(message: ClientMessage): string | undefined {
  return messagePeerKeys.get(message);
}

/**
 * approved: fully open. pending: held until device_auth or an approval; it
 * receives nothing but device_auth replies. dropped: ignored until it leaves.
 */
type RelayPeerAuth = "approved" | "pending" | "dropped";

interface RelayPeer {
  publicKey: Uint8Array | null;
  publicKeyBase64: string | null;
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
  pairingToken: string;
  keyPair: KeyPair;
  lane?: RelayLane;
  /**
   * Without an authorizer every key is approved, which is only right for
   * tests. Index.ts always passes the device registry gate.
   */
  peerAuth?: RelayPeerAuthorizer;
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
   * protocol.
   */
  onPeerJson?: (msg: Record<string, unknown>, peerId: string, publicKey: string) => void;
  /**
   * Build the authoritative capability payload for this server. Keeping this
   * in index.ts ensures direct and relay handshakes cannot advertise different
   * feature sets as new capabilities are added.
   */
  serverCapabilities?: (
    binaryEnvelope: boolean,
    lane: TransportLane,
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
  private status: RelayStatus = "disconnected";
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;
  private outbox = new RelayMessageOutbox();
  private static PING_INTERVAL = 30_000;  // send ping every 30s
  private static PING_TIMEOUT = 10_000;   // if no pong within 10s, connection is dead

  // Virtual WebSocket interface for ClaudeSession compatibility
  private virtualWs: VirtualRelaySocket;

  constructor(private opts: RelayClientOptions) {
    this.virtualWs = new VirtualRelaySocket(this);
  }

  /** Get a WebSocket-like object that ClaudeSession can use */
  getVirtualSocket(): VirtualRelaySocket {
    return this.virtualWs;
  }

  /** Connect to the relay server */
  connect(): void {
    if (this.closed) return;
    this.setStatus("connecting");

    const url = `${this.opts.relayUrl}?token=${encodeURIComponent(this.opts.pairingToken)}&role=server&multi_device=1`;
    console.log(`[Relay] Connecting to ${this.opts.relayUrl}...`);

    try {
      this.ws = new WebSocket(url);
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
      this.pongReceived = true;
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

    this.ws.on("close", () => {
      console.log(`[Relay] Disconnected`);
      this.stopPingPong();
      this.ws = null;
      for (const id of Array.from(this.peers.keys())) this.removePeer(id);
      this.virtualWs.supportsSessionEventAck = false;
      this.virtualWs.supportsMonitorOutputAck = false;
      this.virtualWs.supportsRawSdkEvents = false;
      this.relaySupportsMultiDevice = false;
      this.virtualWs._noteTransportReset();
      this.setStatus("disconnected");
      if (!this.closed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error(`[Relay] Error: ${err.message}`);
      // close event will follow
    });
  }

  /** Send a server→client message through the relay (encrypted if paired) */
  send(msg: Record<string, unknown>): void {
    const pairedPeers = Array.from(this.peers.entries())
      .filter(([, peer]) => peer.auth === "approved" && peer.publicKey !== null);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || pairedPeers.length === 0) {
      // Link peers never receive the broadcast stream, queued or live.
      if (this.opts.lane !== "link") this.outbox.enqueue(msg);
      return;
    }

    for (const [peerId, peer] of pairedPeers) {
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
      this.sendToPeer(peerId, { type: "device_auth_result", ok: true }, peer, true);
      this.openHeldPeer(peerId, peer);
      opened++;
    }
    return opened;
  }

  /**
   * Stops talking to every peer under this key. The relay has no server-side
   * kick, so the peer is told once and then ignored until it disconnects.
   */
  dropPeersWithKey(publicKey: string, reason: "removed" | "not_approved"): number {
    let dropped = 0;
    for (const [peerId, peer] of this.peers) {
      if (peer.auth === "dropped" || peer.publicKeyBase64 !== publicKey) continue;
      this.sendToPeer(peerId, { type: "device_auth_result", ok: false, reason }, peer, true);
      this.dropPeer(peerId, peer, reason === "removed");
      dropped++;
    }
    return dropped;
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
    this.virtualWs._setOpen(false);
    this.setStatus("disconnected");
  }

  private getPeer(peerId = LEGACY_PEER_ID): RelayPeer {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = {
        publicKey: null,
        publicKeyBase64: null,
        // Without a gate every peer is admitted at key exchange, as before.
        // With one, a peer stays held until the gate approves it.
        auth: this.opts.peerAuth ? "pending" : "approved",
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
    if (peer.auth === "approved" && peer.publicKeyBase64) {
      this.opts.onPeerClosed?.(peerId, peer.publicKeyBase64);
    } else if (peer.auth === "pending" && peer.publicKeyBase64) {
      this.opts.onPendingDropped?.(peer.publicKeyBase64);
    }
  }

  private dropPeer(peerId: string, peer: RelayPeer, wasOpen: boolean): void {
    const key = peer.publicKeyBase64;
    const wasApproved = peer.auth === "approved";
    this.clearPendingTimer(peer);
    peer.auth = "dropped";
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

  /** A held peer becomes a normal peer: open the lane, replay the outbox. */
  private openHeldPeer(peerId: string, peer: RelayPeer): void {
    this.clearPendingTimer(peer);
    peer.auth = "approved";
    this.virtualWs._setOpen(true);
    this.setStatus("paired");
    console.log(`[Relay${this.laneTag()}] Peer ${peerId} approved`);
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
      if (peer.auth === "pending") this.openHeldPeer(peerId, peer);
      return;
    }
    const outcome = this.opts.peerAuth.deviceAuth(peer.publicKeyBase64, this.opts.lane || "control", {
      token: msg.token, name: msg.name, platform: msg.platform,
    });
    if (outcome.ok) {
      this.sendToPeer(peerId, { type: "device_auth_result", ok: true }, peer, true);
      if (peer.auth === "pending") this.openHeldPeer(peerId, peer);
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
    if (!peer.publicKey) return;
    // A held peer gets device_auth replies and nothing else.
    if (peer.auth !== "approved" && !allowHeld) return;

    const json = JSON.stringify(msg);
    if (peer.binaryEnabled) {
      const jsonBytes = new TextEncoder().encode(json);
      const plaintext = new Uint8Array(jsonBytes.length + 1);
      plaintext[0] = BIN_MARKER_JSON;
      plaintext.set(jsonBytes, 1);
      const envelope = encryptBinary(plaintext, peer.publicKey, this.opts.keyPair.secretKey);
      this.sendRawFrameToPeer(peerId, envelope, true);
    } else {
      const envelope = encrypt(json, peer.publicKey, this.opts.keyPair.secretKey);
      this.sendRawFrameToPeer(peerId, JSON.stringify(envelope), false);
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
      peer.auth !== "approved" || !peer.publicKey || !peer.binaryEnabled || !peer.supportsBinaryFileDownload
    )) {
      return false;
    }
    for (const [targetPeerId, peer] of targets) {
      const plaintext = encodeBinaryFileDownloadChunk(metadata, bytes);
      const envelope = encryptBinary(plaintext, peer.publicKey!, this.opts.keyPair.secretKey);
      this.sendRawFrameToPeer(targetPeerId, envelope, true);
    }
    return true;
  }

  /** Send an encoded browser frame to one phone, if it reads binary frames. */
  sendBinaryBrowserFrame(encoded: Buffer, peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer?.publicKey || peer.auth !== "approved" || !peer.binaryEnabled || !peer.supportsBinaryBrowserFrames) return false;
    if (this.ws?.readyState !== WebSocket.OPEN) return true;
    this.sendRawFrameToPeer(peerId, encryptBinary(encoded, peer.publicKey, this.opts.keyPair.secretKey), true);
    return true;
  }

  private handleRelayMessage(parsed: unknown): void {
    if (!isRecord(parsed)) throw new Error("Invalid relay control message");
    if (parsed.type === "relay_capabilities") {
      this.relaySupportsMultiDevice = !!parsed.multiDevice;
      if (this.relaySupportsMultiDevice) {
        console.log(`[Relay] Relay supports multi-device routing`);
      }
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
        this.handlePeerMessage(JSON.parse(String(parsed.data || "")), peerId);
      } catch (err) {
        console.error(`[Relay] Failed to parse peer message: ${errorMessage(err)}`);
      }
      return;
    }

    this.handlePeerMessage(parsed, LEGACY_PEER_ID);
  }

  private handlePeerMessage(parsed: unknown, peerId: string): void {
    if (!isRecord(parsed)) throw new Error("Invalid relay peer message");
    const peer = this.getPeer(peerId);

    // Key exchange (plaintext from phone)
    if (parsed.type === "key_exchange") {
      console.log(`[Relay${this.laneTag()}] Received peer public key${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
      if (typeof parsed.pubkey !== "string") throw new Error("Missing relay public key");
      const nextPhonePublicKey = fromBase64(parsed.pubkey);
      if (nextPhonePublicKey.length !== 32) throw new Error("Invalid relay public key");
      const nextKeyBase64 = toBase64(nextPhonePublicKey);
      if (peer.publicKey && peer.publicKeyBase64 !== nextKeyBase64) {
        console.warn(`[Relay] Phone ${peerId} changed public key; replacing peer crypto state`);
        if (peer.auth === "approved") this.dropPeer(peerId, peer, true);
      }
      this.clearPendingTimer(peer);
      peer.publicKey = nextPhonePublicKey;
      peer.publicKeyBase64 = nextKeyBase64;
      const lane = this.opts.lane || "control";
      const admission = this.opts.peerAuth ? this.opts.peerAuth.authorize(nextKeyBase64, lane) : "approved";

      if (admission === "approved") {
        peer.auth = "approved";
        this.virtualWs._setOpen(true);
        this.setStatus("paired");
        // Send ack PLAINTEXT. The phone needs this to confirm the handshake
        // before encrypted mode begins. It contains no sensitive data.
        this.sendPlainToPeer(peerId, { type: "key_exchange_ack", device: "approved" });
        console.log(`[Relay${this.laneTag()}] Key exchange complete, encrypted channel established`);
        this.flushOutboxToPeer(peerId, peer);
        this.opts.onPeerOpened?.(peerId, nextKeyBase64);
        return;
      }

      // Held or refused peers get the same plaintext ack so the app knows to
      // authenticate, then an encrypted reason when there is nothing to wait for.
      this.sendPlainToPeer(peerId, { type: "key_exchange_ack", device: "pending" });
      if (admission === "refused") {
        peer.auth = "pending";
        this.sendToPeer(peerId, { type: "device_auth_result", ok: false, reason: "wrong_lane" }, peer, true);
        peer.auth = "dropped";
        console.warn(`[Relay${this.laneTag()}] Refused peer ${peerId}: key is not allowed on this lane`);
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
      if (!peer.publicKey) {
        console.error(`[Relay] Received encrypted message before key exchange${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
        return;
      }
      if (peer.auth === "dropped") return;
      try {
        const plaintext = decrypt(
          { n: parsed.n, c: parsed.c },
          peer.publicKey,
          this.opts.keyPair.secretKey
        );
        this.routeDecryptedJson(JSON.parse(plaintext), peerId, peer);
      } catch (err) {
        console.error(`[Relay] Decryption failed${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}: ${errorMessage(err)}`);
      }
      return;
    }

    console.warn(`[Relay] Unknown message type: ${parsed.type || "no type"}`);
  }

  /**
   * Decrypted JSON from a peer. Held peers may only authenticate. Link peers
   * bypass client-message parsing and go to the peer API.
   */
  private routeDecryptedJson(parsed: unknown, peerId: string, peer: RelayPeer): void {
    if (peer.auth === "dropped") return;
    if (this.opts.onPeerJson) {
      if (peer.auth !== "approved" || !peer.publicKeyBase64) return;
      if (!isRecord(parsed)) throw new Error("Invalid peer message");
      this.opts.onPeerJson(parsed, peerId, peer.publicKeyBase64);
      return;
    }
    const msg = parseClientMessage(parsed);
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
    if (!peer.publicKey) {
      console.error(`[Relay] Binary frame received before key exchange — dropping${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
      return;
    }
    if (peer.auth === "dropped") return;
    let plaintext: Uint8Array;
    try {
      plaintext = decryptBinary(buf, peer.publicKey, this.opts.keyPair.secretKey);
    } catch (err) {
      console.error(`[Relay] Binary decryption failed${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}: ${errorMessage(err)}`);
      return;
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
        this.sendToPeer(peerId, this.opts.serverCapabilities(peer.binaryEnabled, lane), peer);
      }
      return;
    }
    messagePeers.set(msg, peerId);
    const key = this.getPeer(peerId).publicKeyBase64;
    if (key) messagePeerKeys.set(msg, key);
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
    this.pongReceived = true;
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.pongReceived) {
        // No pong received since last ping — connection is dead
        console.warn(`[Relay] No pong received in ${RelayClient.PING_INTERVAL / 1000}s — forcing reconnect`);
        this.ws.terminate(); // force-close, triggers 'close' event → scheduleReconnect
        return;
      }
      this.pongReceived = false;
      this.ws.ping();
    }, RelayClient.PING_INTERVAL);
  }

  private stopPingPong(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
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
