import { WebSocket } from "ws";
import { supportsBinaryBrowserFrames } from "./browser-frame-wire";
import { parseClientMessage } from "./client-message";
import type { ClientTransport } from "./client-transport";
import { BinaryFileDownloadChunkMetadata, encodeBinaryFileDownloadChunk, supportsBinaryFileDownload } from "./file-transfer-wire";
import type { ClientMessage } from "./protocol";
import type { MessageChannelKind } from "./relay-client";
import { KeyPair, PeerChannel, SessionKeyedPeerStore, acceptKeyExchange, isSessionKeyDowngrade, toBase64 } from "./relay-crypto";
import { isRecord } from "./value-guards";

// Binary envelope plaintext markers — first byte of the decrypted payload.
export const BIN_MARKER_JSON = 0x4A;          // 'J' — UTF-8 JSON message follows
export const BIN_MARKER_UPLOAD_CHUNK = 0x42;  // 'B' — upload chunk: [1 idLen][idBytes][4 chunkIdx BE][bytes]

/**
 * One old-path direct socket: the loopback token socket, or an `e2e=1` socket
 * that seals its frames after a key exchange. index.ts makes one per socket
 * and reads its frames through it. [sessionKeyedPeers] is the shared record
 * of keys that have used session keys.
 */
export class DirectClientTransport implements ClientTransport {
  private peerPublicKey: Uint8Array | null = null;
  private channel: PeerChannel | null = null;
  private binaryEnabled = false;
  private authenticated: boolean;
  private binaryFileDownloadEnabled = false;
  private binaryBrowserFramesEnabled = false;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  supportsRawSdkEvents = false;
  supportsSessionEventAck = false;
  supportsMonitorOutputAck = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly keyPair: KeyPair,
    private readonly sessionKeyedPeers: SessionKeyedPeerStore,
    opts: { authenticated: boolean; requireEncryptedAuth: boolean },
  ) {
    this.authenticated = opts.authenticated && !opts.requireEncryptedAuth;
    this.holdsAuthToken = this.authenticated;
    if (opts.requireEncryptedAuth) {
      this.authTimer = setTimeout(() => {
        if (this.authenticated || this.ws.readyState !== WebSocket.OPEN) return;
        console.warn("[Direct E2E] Closing unauthenticated encrypted direct socket after timeout");
        this.ws.close(1008, "Authentication timeout");
      }, 15_000);
    }
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  get usesBinaryEnvelope(): boolean {
    return this.binaryEnabled;
  }

  get hasPeerKey(): boolean {
    return this.channel !== null;
  }

  get peerKey(): string | undefined {
    return this.peerPublicKey ? toBase64(this.peerPublicKey) : undefined;
  }

  /** True when this client proved AUTH_TOKEN. See [mayLearnAuthToken] before repeating it. */
  holdsAuthToken = false;

  /**
   * Whether capabilities sent to this client may carry AUTH_TOKEN. It proved
   * the token, and it is still a socket from this computer or one whose key
   * [isRecordedDevice] knows. A removed device's socket that is still open
   * fails the second part, so it never learns the token made for its removal.
   */
  mayLearnAuthToken(isRecordedDevice: (publicKey: string) => boolean): boolean {
    if (!this.holdsAuthToken) return false;
    if (this.fromThisComputer) return true;
    const key = this.peerKey;
    return key !== undefined && isRecordedDevice(key);
  }

  /** The socket comes from this computer itself: loopback with no proxy in front. */
  fromThisComputer = false;

  /** How this socket's frames are keyed, for rules that need session keys. */
  get channelKind(): MessageChannelKind {
    if (!this.channel) return "plain";
    return this.channel.sessionKeyed ? "session" : "static";
  }

  /** Set while the key waits for another device to approve it. */
  heldForApproval = false;

  /** Keeps the socket open past the auth timeout while approval is pending. */
  holdForApproval(): void {
    this.heldForApproval = true;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = setTimeout(() => {
      if (this.authenticated || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.close(1008, "Approval timed out");
    }, 10 * 60 * 1000);
  }

  send(data: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.channel) {
      this.ws.send(data);
      return;
    }

    if (this.binaryEnabled) {
      const jsonBytes = new TextEncoder().encode(data);
      const plaintext = new Uint8Array(jsonBytes.length + 1);
      plaintext[0] = BIN_MARKER_JSON;
      plaintext.set(jsonBytes, 1);
      this.ws.send(this.channel.sealBinary(plaintext), { binary: true });
      return;
    }

    this.ws.send(JSON.stringify(this.channel.sealText(data)));
  }

  sendPlain(msg: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Throws on a bad exchange, or a static-box one from a key that used session keys. */
  handleKeyExchange(message: Record<string, unknown>): void {
    const exchange = acceptKeyExchange(message, this.keyPair, this.sessionKeyedPeers);
    if (this.peerPublicKey && toBase64(this.peerPublicKey) !== exchange.peerPublicKeyBase64) {
      console.warn("[Direct E2E] Phone public key changed; replacing peer crypto state");
    }
    this.peerPublicKey = exchange.peerPublicKey;
    this.channel = exchange.channel;
    this.sendPlain({ type: "key_exchange_ack", ...exchange.ack });
    console.log(`[Direct E2E] Key exchange complete (${exchange.channel.sessionKeyed ? "session key" : "static key"}) — waiting for encrypted auth`);
  }

  /**
   * Whether the client speaks session keys although this socket's handshake
   * had none, which means someone stripped them. Holds its key to them.
   */
  isSessionKeyDowngrade(message: unknown): boolean {
    if (!this.channel || !isSessionKeyDowngrade(message, this.channel)) return false;
    if (this.peerPublicKey) this.sessionKeyedPeers.add(toBase64(this.peerPublicKey));
    return true;
  }

  authenticate(binaryEnvelope: boolean): void {
    this.authenticated = true;
    this.heldForApproval = false;
    this.binaryEnabled = binaryEnvelope;
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  setClientCapabilities(message: unknown): void {
    this.binaryFileDownloadEnabled = supportsBinaryFileDownload(message);
    this.binaryBrowserFramesEnabled = supportsBinaryBrowserFrames(message);
  }

  sendBinaryBrowserFrame(encoded: Buffer): boolean {
    if (!this.binaryBrowserFramesEnabled) return false;
    if (this.ws.readyState !== WebSocket.OPEN) return true;
    this.ws.send(
      this.channel ? this.channel.sealBinary(encoded) : encoded,
      { binary: true },
    );
    return true;
  }

  supportsBinaryFileDownload(): boolean {
    return this.binaryFileDownloadEnabled;
  }

  sendFileDownloadChunk(
    metadata: BinaryFileDownloadChunkMetadata,
    bytes: Buffer,
  ): boolean {
    if (!this.binaryFileDownloadEnabled || this.ws.readyState !== WebSocket.OPEN) return false;
    const plaintext = encodeBinaryFileDownloadChunk(metadata, bytes);
    if (this.channel) {
      this.ws.send(this.channel.sealBinary(plaintext), { binary: true });
    } else {
      this.ws.send(plaintext, { binary: true });
    }
    return true;
  }

  decryptTextEnvelope(parsed: unknown): ClientMessage {
    if (!this.channel) {
      throw new Error("Encrypted direct message before key exchange");
    }
    if (!isRecord(parsed) || typeof parsed.n !== "string" || typeof parsed.c !== "string") {
      throw new Error("Invalid encrypted envelope");
    }
    const plaintext = this.channel.openText({ n: parsed.n, c: parsed.c });
    return parseClientMessage(JSON.parse(plaintext));
  }

  decryptBinaryFrame(buf: Buffer): ClientMessage {
    if (!this.channel) {
      throw new Error("Encrypted direct binary frame before key exchange");
    }
    const plaintext = this.channel.openBinary(buf);
    if (plaintext.length === 0) {
      throw new Error("Empty direct binary frame");
    }
    const marker = plaintext[0];

    if (marker === BIN_MARKER_JSON) {
      const json = new TextDecoder().decode(plaintext.subarray(1));
      return parseClientMessage(JSON.parse(json));
    }

    if (marker === BIN_MARKER_UPLOAD_CHUNK) {
      if (plaintext.length < 6) throw new Error("Binary upload frame too short");
      const idLen = plaintext[1];
      const headerEnd = 2 + idLen + 4;
      if (plaintext.length < headerEnd) throw new Error("Binary upload frame header too short");
      const uploadId = new TextDecoder().decode(plaintext.subarray(2, 2 + idLen));
      const off = 2 + idLen;
      const chunkIndex =
        ((plaintext[off] << 24) >>> 0) |
        (plaintext[off + 1] << 16) |
        (plaintext[off + 2] << 8) |
        plaintext[off + 3];
      const data = Buffer.from(plaintext.subarray(headerEnd));
      return { type: "upload_chunk_bin", uploadId, chunkIndex, data };
    }

    throw new Error(`Unknown direct binary marker: 0x${marker.toString(16)}`);
  }

  close(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }
}
