import WebSocket from "ws";
import { KeyPair, EncryptedEnvelope, encrypt, decrypt, encryptBinary, decryptBinary, toBase64, fromBase64 } from "./relay-crypto";
import { ClientMessage } from "./protocol";

// Binary envelope plaintext markers — first byte of the decrypted payload.
const BIN_MARKER_JSON = 0x4A;          // 'J' — UTF-8 JSON message follows
const BIN_MARKER_UPLOAD_CHUNK = 0x42;  // 'B' — upload chunk: [1 idLen][idBytes][4 chunkIdx BE][bytes]

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
  private phonePublicKey: Uint8Array | null = null;
  private status: RelayStatus = "disconnected";
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;
  private static PING_INTERVAL = 30_000;  // send ping every 30s
  private static PING_TIMEOUT = 10_000;   // if no pong within 10s, connection is dead

  // Wire-format flag — flipped to true after the phone announces
  // {type: "client_capabilities", binaryEnvelope: true}. While false we keep
  // sending the legacy JSON `{n, c}` envelope so older app builds keep working.
  private binaryEnabled = false;

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

    const url = `${this.opts.relayUrl}?token=${encodeURIComponent(this.opts.pairingToken)}&role=server`;
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
      this.phonePublicKey = null;
      this.binaryEnabled = false;
      this.virtualWs._setOpen(false);
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const json = JSON.stringify(msg);

    if (!this.phonePublicKey) {
      // Pre-key-exchange: send plaintext (only used for key_exchange_ack)
      this.ws.send(json);
      return;
    }

    if (this.binaryEnabled) {
      // Binary envelope: 1-byte JSON marker + UTF-8 JSON, encrypted as raw bytes.
      const jsonBytes = new TextEncoder().encode(json);
      const plaintext = new Uint8Array(jsonBytes.length + 1);
      plaintext[0] = BIN_MARKER_JSON;
      plaintext.set(jsonBytes, 1);
      const envelope = encryptBinary(plaintext, this.phonePublicKey, this.opts.keyPair.secretKey);
      this.ws.send(envelope, { binary: true });
    } else {
      // Legacy text JSON envelope `{n, c}`.
      const envelope = encrypt(json, this.phonePublicKey, this.opts.keyPair.secretKey);
      this.ws.send(JSON.stringify(envelope));
    }
  }

  /** Whether the relay is connected and paired with a phone */
  get isPaired(): boolean {
    return this.status === "paired" && this.phonePublicKey !== null;
  }

  get currentStatus(): RelayStatus {
    return this.status;
  }

  /** Disconnect and stop reconnecting */
  close(): void {
    this.closed = true;
    this.stopPingPong();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  private handleRelayMessage(parsed: any): void {
    // Relay control messages (unencrypted)
    if (parsed.type === "peer_connected") {
      console.log(`[Relay] Phone connected to relay`);
      this.setStatus("waiting_for_peer"); // Will become "paired" after key exchange
      return;
    }

    if (parsed.type === "peer_disconnected") {
      console.log(`[Relay] Phone disconnected from relay`);
      this.phonePublicKey = null;
      this.binaryEnabled = false;  // next phone may be old-format
      this.virtualWs._setOpen(false);
      this.setStatus("waiting_for_peer");
      return;
    }

    // Key exchange (plaintext from phone)
    if (parsed.type === "key_exchange") {
      console.log(`[Relay] Received phone public key`);
      this.phonePublicKey = fromBase64(parsed.pubkey);
      this.setStatus("paired");
      this.virtualWs._setOpen(true);

      // Send ack PLAINTEXT — phone needs this to confirm handshake before
      // encrypted mode begins. Contains no sensitive data.
      if (this.ws) {
        this.ws.send(JSON.stringify({ type: "key_exchange_ack" }));
      }
      console.log(`[Relay] Key exchange complete — encrypted channel established`);
      return;
    }

    // Encrypted message from phone
    if (parsed.n && parsed.c) {
      if (!this.phonePublicKey) {
        console.error(`[Relay] Received encrypted message before key exchange`);
        return;
      }
      try {
        const plaintext = decrypt(
          parsed as EncryptedEnvelope,
          this.phonePublicKey,
          this.opts.keyPair.secretKey
        );
        const msg = JSON.parse(plaintext) as ClientMessage;
        this.dispatchClientMessage(msg);
      } catch (err: any) {
        console.error(`[Relay] Decryption failed: ${err.message}`);
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
  private handleBinaryFrame(buf: Buffer): void {
    if (!this.phonePublicKey) {
      console.error(`[Relay] Binary frame received before key exchange — dropping`);
      return;
    }
    let plaintext: Uint8Array;
    try {
      plaintext = decryptBinary(buf, this.phonePublicKey, this.opts.keyPair.secretKey);
    } catch (err: any) {
      console.error(`[Relay] Binary decryption failed: ${err.message}`);
      return;
    }
    if (plaintext.length === 0) return;
    const marker = plaintext[0];

    if (marker === BIN_MARKER_JSON) {
      try {
        const json = new TextDecoder().decode(plaintext.subarray(1));
        const msg = JSON.parse(json) as ClientMessage;
        this.dispatchClientMessage(msg);
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
      } as any);
      return;
    }

    console.warn(`[Relay] Unknown binary marker: 0x${marker.toString(16)}`);
  }

  /**
   * Dispatch a decrypted client message. Intercepts the wire-format capability
   * handshake so the rest of the server never sees it; everything else goes
   * through to the handler.
   */
  private dispatchClientMessage(msg: ClientMessage): void {
    if ((msg as any).type === "client_capabilities") {
      const wantsBinary = !!(msg as any).binaryEnvelope;
      if (wantsBinary && !this.binaryEnabled) {
        this.binaryEnabled = true;
        console.log(`[Relay] Phone announced binary envelope support — flipping outbound to binary`);
      }
      // Ack so the phone knows the server is now sending binary.
      this.send({ type: "server_capabilities", binaryEnvelope: this.binaryEnabled });
      return;
    }
    this.opts.onMessage(msg);
  }

  private setStatus(status: RelayStatus): void {
    this.status = status;
    this.opts.onStatusChange(status);
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
  readyState: number = WebSocket.CLOSED;
  private _onMessageCallbacks: ((data: Buffer) => void)[] = [];
  private _onCloseCallbacks: (() => void)[] = [];

  constructor(private relay: RelayClient) {}

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
    this.readyState = open ? WebSocket.OPEN : WebSocket.CLOSED;
    if (wasOpen && !open) {
      for (const cb of this._onCloseCallbacks) cb();
    }
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
