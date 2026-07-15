import WebSocket from "ws";
import { KeyPair, EncryptedEnvelope, encrypt, decrypt, encryptBinary, decryptBinary, toBase64, fromBase64 } from "./relay-crypto";
import { ClientMessage } from "./protocol";
import { detectAvailableBackends } from "./codex-session";
import { getAdvertisedServerSettings } from "./server-settings";

// Binary envelope plaintext markers — first byte of the decrypted payload.
const BIN_MARKER_JSON = 0x4A;          // 'J' — UTF-8 JSON message follows
const BIN_MARKER_UPLOAD_CHUNK = 0x42;  // 'B' — upload chunk: [1 idLen][idBytes][4 chunkIdx BE][bytes]
const LEGACY_PEER_ID = "legacy";

interface RelayPeer {
  publicKey: Uint8Array | null;
  binaryEnabled: boolean;
  sessionEventAck: boolean;
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
  private messages: Array<{ message: Record<string, unknown>; bytes: number }> = [];
  private totalBytes = 0;
  private droppedMessages = 0;

  constructor(
    private readonly maxMessages = 4_000,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  enqueue(message: Record<string, unknown>): void {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    this.messages.push({ message, bytes });
    this.totalBytes += bytes;
    while (
      this.messages.length > this.maxMessages ||
      this.totalBytes > this.maxBytes
    ) {
      const removed = this.messages.shift();
      if (!removed) break;
      this.totalBytes -= removed.bytes;
      this.droppedMessages++;
    }
  }

  drain(): RelayOutboxDrain {
    const result = {
      messages: this.messages.map((entry) => entry.message),
      droppedMessages: this.droppedMessages,
    };
    this.messages = [];
    this.totalBytes = 0;
    this.droppedMessages = 0;
    return result;
  }

  get length(): number {
    return this.messages.length;
  }
}

export type RelayStatus = "disconnected" | "connecting" | "waiting_for_peer" | "paired" | "error";

export interface RelayClientOptions {
  relayUrl: string;
  pairingToken: string;
  keyPair: KeyPair;
  onMessage: (msg: ClientMessage) => void;
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
    } catch (err: any) {
      console.error(`[Relay] Connection error: ${err.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log(`[Relay] Connected, waiting for phone...`);
      this.reconnectDelay = 1000; // reset backoff
      this.setStatus("waiting_for_peer");
      this.virtualWs._setOpen(true);

      // Enable TCP keepalive on the underlying socket to detect dead connections
      const socket = (this.ws as any)?._socket;
      if (socket?.setKeepAlive) {
        socket.setKeepAlive(true, 60_000);
      }

      // Start WebSocket-level ping/pong keepalive
      this.startPingPong();
    });

    this.ws.on("pong", () => {
      this.pongReceived = true;
    });

    this.ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          this.handleBinaryFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
          return;
        }
        const raw = data.toString();
        const parsed = JSON.parse(raw);
        this.handleRelayMessage(parsed);
      } catch (err: any) {
        console.error(`[Relay] Failed to parse message: ${err.message}`);
      }
    });

    this.ws.on("close", () => {
      console.log(`[Relay] Disconnected`);
      this.stopPingPong();
      this.ws = null;
      this.peers.clear();
      this.virtualWs.supportsSessionEventAck = false;
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
      .filter(([, peer]) => peer.publicKey !== null);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || pairedPeers.length === 0) {
      this.outbox.enqueue(msg);
      return;
    }

    for (const [peerId, peer] of pairedPeers) {
      this.sendToPeer(peerId, msg, peer);
    }
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
    this.peers.clear();
    this.virtualWs.supportsSessionEventAck = false;
    this.relaySupportsMultiDevice = false;
    this.virtualWs._setOpen(false);
    this.setStatus("disconnected");
  }

  private getPeer(peerId = LEGACY_PEER_ID): RelayPeer {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = { publicKey: null, binaryEnabled: false, sessionEventAck: false };
      this.peers.set(peerId, peer);
    }
    return peer;
  }

  private hasPairedPeer(): boolean {
    return Array.from(this.peers.values()).some((peer) => peer.publicKey !== null);
  }

  private sendRawFrameToPeer(peerId: string, data: string | Buffer, binary: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.relaySupportsMultiDevice) {
      this.ws.send(JSON.stringify({
        type: "relay_to_peer",
        peerId,
        binary,
        data: binary ? Buffer.from(data as Buffer).toString("base64") : data.toString(),
      }));
      return;
    }

    this.ws.send(data, { binary });
  }

  private sendPlainToPeer(peerId: string, msg: Record<string, unknown>): void {
    this.sendRawFrameToPeer(peerId, JSON.stringify(msg), false);
  }

  private sendToPeer(peerId: string, msg: Record<string, unknown>, peer = this.getPeer(peerId)): void {
    if (!peer.publicKey) return;

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

  private handleRelayMessage(parsed: any): void {
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
        this.peers.delete(peerId);
        console.log(`[Relay] Phone disconnected from relay (${peerId})`);
      } else {
        this.peers.clear();
        console.log(`[Relay] Phone disconnected from relay`);
      }
      const stillPaired = this.hasPairedPeer();
      this.virtualWs.supportsSessionEventAck = Array.from(this.peers.values())
        .some((connectedPeer) => connectedPeer.sessionEventAck);
      if (!stillPaired) this.virtualWs._noteTransportReset();
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
      } catch (err: any) {
        console.error(`[Relay] Failed to parse peer message: ${err.message}`);
      }
      return;
    }

    this.handlePeerMessage(parsed, LEGACY_PEER_ID);
  }

  private handlePeerMessage(parsed: any, peerId: string): void {
    const peer = this.getPeer(peerId);

    // Key exchange (plaintext from phone)
    if (parsed.type === "key_exchange") {
      console.log(`[Relay] Received phone public key${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
      const nextPhonePublicKey = fromBase64(parsed.pubkey);
      if (peer.publicKey && toBase64(peer.publicKey) !== toBase64(nextPhonePublicKey)) {
        console.warn(`[Relay] Phone ${peerId} changed public key; replacing peer crypto state`);
      }
      peer.publicKey = nextPhonePublicKey;
      this.virtualWs._setOpen(true);
      this.setStatus("paired");

      // Send ack PLAINTEXT — phone needs this to confirm handshake before
      // encrypted mode begins. Contains no sensitive data.
      this.sendPlainToPeer(peerId, { type: "key_exchange_ack" });
      console.log(`[Relay] Key exchange complete — encrypted channel established`);
      this.flushOutboxToPeer(peerId, peer);
      return;
    }

    // Encrypted message from phone
    if (parsed.n && parsed.c) {
      if (!peer.publicKey) {
        console.error(`[Relay] Received encrypted message before key exchange${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
        return;
      }
      try {
        const plaintext = decrypt(
          parsed as EncryptedEnvelope,
          peer.publicKey,
          this.opts.keyPair.secretKey
        );
        const msg = JSON.parse(plaintext) as ClientMessage;
        this.dispatchClientMessage(msg, peerId);
      } catch (err: any) {
        console.error(`[Relay] Decryption failed${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}: ${err.message}`);
      }
      return;
    }

    console.warn(`[Relay] Unknown message type: ${parsed.type || "no type"}`);
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
    let plaintext: Uint8Array;
    try {
      plaintext = decryptBinary(buf, peer.publicKey, this.opts.keyPair.secretKey);
    } catch (err: any) {
      console.error(`[Relay] Binary decryption failed${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}: ${err.message}`);
      return;
    }
    if (plaintext.length === 0) return;
    const marker = plaintext[0];

    if (marker === BIN_MARKER_JSON) {
      try {
        const json = new TextDecoder().decode(plaintext.subarray(1));
        const msg = JSON.parse(json) as ClientMessage;
        this.dispatchClientMessage(msg, peerId);
      } catch (err: any) {
        console.error(`[Relay] Binary JSON parse failed: ${err.message}`);
      }
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
      } as any, peerId);
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
    if ((msg as any).type === "client_capabilities") {
      const wantsBinary = !!(msg as any).binaryEnvelope;
      const peer = this.getPeer(peerId);
      peer.sessionEventAck = (msg as any).sessionEventAck === true;
      this.virtualWs.supportsSessionEventAck = Array.from(this.peers.values())
        .some((connectedPeer) => connectedPeer.sessionEventAck);
      if (wantsBinary && !peer.binaryEnabled) {
        peer.binaryEnabled = true;
        console.log(`[Relay] Phone announced binary envelope support — flipping outbound to binary${peerId !== LEGACY_PEER_ID ? ` (${peerId})` : ""}`);
      }
      // Ack so the phone knows the server is now sending binary, and tell it
      // which agent backends this server supports plus current health state.
      const settings = getAdvertisedServerSettings();
      this.sendToPeer(peerId, {
        type: "server_capabilities",
        binaryEnvelope: peer.binaryEnabled,
        secretManagement: { version: 1 },
        backends: detectAvailableBackends(),
        codexDriver: settings.codexDriver,
        codexDriversAvailable: settings.codexDriversAvailable,
        backendHealth: settings.backendHealth,
      }, peer);
      return;
    }
    this.opts.onMessage(msg);
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
  private _onMessageCallbacks: ((data: Buffer) => void)[] = [];
  private _onCloseCallbacks: (() => void)[] = [];

  constructor(private relay: RelayClient) {}

  get bufferedAmount(): number {
    return this.relay.bufferedAmount;
  }

  send(data: string): void {
    try {
      const msg = JSON.parse(data);
      this.relay.send(msg);
    } catch {
      // If it's not JSON, send raw
      this.relay.send({ raw: data });
    }
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
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === "message") this._onMessageCallbacks.push(cb);
    if (event === "close") this._onCloseCallbacks.push(cb);
  }
}
