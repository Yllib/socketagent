import WebSocket from "ws";
import type { BinaryFileDownloadChunkMetadata } from "./file-transfer-wire";
import { encodeBinaryFileDownloadChunk, supportsBinaryFileDownload } from "./file-transfer-wire";
import { supportsBinaryBrowserFrames } from "./browser-frame-wire";
import { parseClientMessage } from "./client-message";
import type { ClientTransport } from "./client-transport";
import {
  supportsMonitorOutputAcknowledgement,
  supportsSessionEventAcknowledgement,
  type ClientMessage,
  type TransportLane,
} from "./protocol";
import { noteDirectMessageOrigin } from "./relay-client";
import {
  HANDSHAKE_WAIT_MS,
  HELD_PEER_WAIT_MS,
  isTransportReady,
  type AcceptedHandshake,
  type PairingUpdate,
  type Hs1Arrival,
  type PendingNotice,
  type TransportResponder,
} from "./transport-responder";
import { closeThenDestroy } from "./socket-teardown";
import { MAX_HANDSHAKE_FRAME_BYTES, parseHs1Frame, TRANSPORT_VERSION } from "./transport-v2";
import { errorMessage, isRecord } from "./value-guards";

// First byte of a binary record's plaintext.
const BIN_MARKER_JSON = 0x4A;
const BIN_MARKER_UPLOAD_CHUNK = 0x42;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_NORMAL = 1000;

/**
 * The largest frame the direct listener takes, on `e2e=2`, `e2e=1` and the
 * loopback token socket alike. It is the relay's own cap, so whatever an app
 * can send through the relay it can send directly. The largest real frames
 * are upload chunks of 1 MiB.
 */
export const MAX_DIRECT_FRAME_BYTES = 16 * 1024 * 1024;

export interface DirectV2Hooks {
  responder: TransportResponder;
  /** The socket comes from this computer itself: loopback with no proxy in front. */
  fromThisComputer: boolean;
  /** The socket's remote address. The responder counts failed handshakes against it. */
  remoteAddress?: string;
  serverCapabilities: (binaryEnvelope: boolean, lane: TransportLane) => Record<string, unknown>;
  /** The `pairing_grant` message for a `local-request` peer that is a recorded device. */
  pairingGrant: () => Record<string, unknown>;
  /** The channel is admitted. Called once, after the first records have gone out. */
  onOpen: (transport: DirectV2Transport) => void;
  /** A sealed message from an open channel. */
  onMessage: (transport: DirectV2Transport, message: ClientMessage) => void;
  /** The peer proved the secret and waits for Allow on a paired device. */
  onDevicePending: (notice: PendingNotice) => void;
  /** A held peer left before it was answered. */
  onPendingDropped: (publicKey: string) => void;
  onClose: (transport: DirectV2Transport) => void;
}

/**
 * One direct `?e2e=2` socket (wire spec 5.2). The first frame is `hs1`, the
 * computer answers `hs2`, and after that only sealed records count. Any other
 * frame, and any record that does not open, closes the socket.
 *
 * Nothing is stored or sent beyond `hs2` until the peer's first record,
 * `transport_ready`, proves it holds the handshake's keys. The lane comes
 * from `hs1`, so `lane` and `peerKey` are only set once the channel is up.
 *
 * The same socket carries the `local-request` path (5.3) for the app in
 * another account on this computer. That peer never gets an open channel:
 * once its key is a recorded device, at once or after Allow, it is sent
 * `pairing_grant` and the socket closes. No record it sends is read past
 * `transport_ready`.
 *
 * When the computer closes the socket, for a removed or denied device or a
 * bad frame, the channel ends in that same tick: no frame that arrives later
 * is read, and a peer that does not answer the close frame is cut off two
 * seconds later.
 */
export class DirectV2Transport implements ClientTransport {
  private state: "waiting" | "answered" | "held" | "open" | "closed" = "waiting";
  private handshake: AcceptedHandshake | null = null;
  private handshakeUsed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private binaryEnabled = false;
  private binaryFileDownloadEnabled = false;
  private binaryBrowserFramesEnabled = false;
  supportsRawSdkEvents = false;
  supportsSessionEventAck = false;
  supportsMonitorOutputAck = false;
  readonly fromThisComputer: boolean;

  constructor(private readonly ws: WebSocket, private readonly hooks: DirectV2Hooks) {
    this.fromThisComputer = hooks.fromThisComputer;
    this.setTimer(HANDSHAKE_WAIT_MS, () => this.closeSocket("No handshake in time"));
    ws.on("message", (data, isBinary) => {
      // A socket this side has closed still hands over what the peer sends until the close completes.
      if (this.state === "closed") return;
      const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      try {
        // Until transport_ready the only frames are hs1 and that one record,
        // both small. A larger one is closed on before it is made a string
        // or parsed, since anyone who reaches the port can send it.
        if ((this.state === "waiting" || this.state === "answered") && frame.length > MAX_HANDSHAKE_FRAME_BYTES) {
          this.closeSocket("Frame too large");
          return;
        }
        if (isBinary) this.handleBinary(frame);
        else this.handleText(frame.toString("utf8"));
      } catch (err: unknown) {
        console.warn(`[Direct v2] Closing socket: ${errorMessage(err)}`);
        this.closeSocket("Invalid frame");
      }
    });
    ws.on("close", () => this.end());
  }

  /**
   * Ends the channel, once: from here no frame is read and nothing is sent,
   * the handshake's place is freed and the hooks are told. Runs when this
   * side closes the socket and when the socket closes by itself.
   */
  private end(): void {
    if (this.state === "closed") return;
    const wasHeld = this.state === "held";
    this.state = "closed";
    this.clearTimer();
    if (this.handshake) {
      this.hooks.responder.release(this.handshake);
      if (wasHeld) this.hooks.onPendingDropped(this.handshake.publicKey);
    }
    this.hooks.onClose(this);
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  /** The lane the handshake named. Control until a handshake is answered. */
  get lane(): TransportLane {
    return this.handshake?.lane === "bulk" ? "bulk" : "control";
  }

  /** The device's key, once its `transport_ready` has proved it. */
  get peerKey(): string | undefined {
    return this.state === "open" || this.state === "held" ? this.handshake?.publicKey : undefined;
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  get isHeld(): boolean {
    return this.state === "held";
  }

  private setTimer(ms: number, onTimeout: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(onTimeout, ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Ends the channel in this tick, then closes the socket without waiting on the peer for long. */
  private closeSocket(reason: string, code = CLOSE_POLICY_VIOLATION): void {
    this.end();
    if (this.ws.readyState === WebSocket.OPEN) closeThenDestroy(this.ws, code, reason);
  }

  private handleText(raw: string): void {
    if (this.state === "closed") return;
    if (!this.handshake) {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.type !== "hs1") {
        this.closeSocket("Handshake required");
        return;
      }
      // Another version, or a second hs1, is ignored. The 10 s timer closes the socket.
      if (parsed.v !== TRANSPORT_VERSION || this.handshakeUsed) return;
      this.handshakeUsed = true;
      const arrival = this.arrivalOf(raw);
      if (!arrival) return;
      const outcome = this.hooks.responder.handleHs1(raw, arrival);
      if (outcome.result === "silent") return;
      this.ws.send(outcome.hs2);
      if (outcome.result === "refused") {
        this.closeSocket("Not approved");
        return;
      }
      this.handshake = outcome.handshake;
      this.state = "answered";
      this.setTimer(HANDSHAKE_WAIT_MS, () => this.closeSocket("No transport_ready in time"));
      return;
    }

    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && parsed.type === "hs1") return;
    if (!isRecord(parsed) || typeof parsed.n !== "string" || typeof parsed.c !== "string") {
      this.closeSocket("Encryption required");
      return;
    }
    const plaintext = this.handshake.channel.openText({ n: parsed.n, c: parsed.c });
    if (this.state === "answered") {
      if (isTransportReady(plaintext)) this.handleTransportReady(this.handshake);
      else this.closeSocket("transport_ready required");
      return;
    }
    // A held peer's records are ignored until a paired device answers.
    if (this.state !== "open") return;
    this.deliverJson(plaintext);
  }

  /**
   * Which handshake this socket may run for an `hs1`. The frame picks
   * between the device lanes and `local-request`, and `local-request` only
   * counts on a socket from this computer. Null means stay silent.
   */
  private arrivalOf(raw: string): Hs1Arrival | null {
    const frame = parseHs1Frame(raw);
    if (!frame) return null;
    if (frame.path === "local-request") return this.fromThisComputer ? { path: "local-request", lane: "control" } : null;
    if (frame.path !== "direct" || (frame.lane !== "control" && frame.lane !== "bulk")) return null;
    return { path: "direct", lane: frame.lane, remoteAddress: this.hooks.remoteAddress };
  }

  private handleBinary(frame: Buffer): void {
    if (this.state === "closed") return;
    if (!this.handshake || this.state === "answered") {
      // The first record is transport_ready, which is text.
      this.closeSocket("Handshake required");
      return;
    }
    const plaintext = this.handshake.channel.openBinary(frame);
    if (this.state !== "open" || plaintext.length === 0) return;
    if (plaintext[0] === BIN_MARKER_JSON) {
      this.deliverJson(Buffer.from(plaintext.subarray(1)).toString("utf8"));
      return;
    }
    if (plaintext[0] === BIN_MARKER_UPLOAD_CHUNK) {
      // [1 marker][1 idLen][idBytes][4 chunkIndex BE][bytes]
      if (plaintext.length < 6) return;
      const idLength = plaintext[1];
      const headerEnd = 2 + idLength + 4;
      if (plaintext.length < headerEnd) return;
      const bytes = Buffer.from(plaintext);
      this.deliver({
        type: "upload_chunk_bin",
        uploadId: bytes.subarray(2, 2 + idLength).toString("utf8"),
        chunkIndex: bytes.readUInt32BE(2 + idLength),
        data: bytes.subarray(headerEnd),
      });
      return;
    }
    console.warn(`[Direct v2] Unknown binary marker: 0x${plaintext[0].toString(16)}`);
  }

  /** A record that opened but holds no message this server knows is answered, not punished. */
  private deliverJson(json: string): void {
    let message: ClientMessage;
    try {
      message = parseClientMessage(JSON.parse(json));
    } catch {
      this.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }
    this.deliver(message);
  }

  private deliver(message: ClientMessage): void {
    const handshake = this.handshake;
    if (!handshake) return;
    // The handshake carried what these did. On v2 they are never sent.
    if (message.type === "device_auth" || message.type === "direct_auth" || message.type === "client_capabilities") return;
    noteDirectMessageOrigin(message, { publicKey: handshake.publicKey, channel: "v2" });
    this.hooks.onMessage(this, message);
  }

  /** The peer holds the handshake's keys. Only now may anything be stored or sent (spec 3.7). */
  private handleTransportReady(handshake: AcceptedHandshake): void {
    this.clearTimer();
    const outcome = this.hooks.responder.ready(handshake);
    if (outcome.result === "closed") {
      this.closeSocket("Handshake no longer valid");
      return;
    }
    if (outcome.result === "open") {
      if (handshake.path === "local-request") this.grantAndClose();
      else this.open(handshake, outcome.pairingUpdate);
      return;
    }
    this.state = "held";
    this.setTimer(HELD_PEER_WAIT_MS, () => this.deny());
    this.hooks.onDevicePending(outcome.notice);
  }

  /** The whole of a `local-request` channel once its key is a recorded device: one record, then the close. */
  private grantAndClose(): void {
    this.sendSealed(JSON.stringify(this.hooks.pairingGrant()));
    this.closeSocket("Pairing granted", CLOSE_NORMAL);
  }

  /** The first records of an open channel: `pairing_update` when one is due, then `server_capabilities`. */
  private open(handshake: AcceptedHandshake, pairingUpdate?: PairingUpdate): void {
    const caps = handshake.caps;
    this.state = "open";
    this.binaryEnabled = caps.binaryEnvelope === true;
    this.binaryFileDownloadEnabled = supportsBinaryFileDownload(caps);
    this.binaryBrowserFramesEnabled = supportsBinaryBrowserFrames(caps);
    this.supportsSessionEventAck = supportsSessionEventAcknowledgement(caps);
    this.supportsMonitorOutputAck = supportsMonitorOutputAcknowledgement(caps);
    if (pairingUpdate) this.send(JSON.stringify(pairingUpdate));
    this.send(JSON.stringify(this.hooks.serverCapabilities(this.binaryEnabled, this.lane)));
    this.hooks.onOpen(this);
  }

  /** A paired device allowed this held peer, and the index has recorded its key. */
  approve(): void {
    if (this.state !== "held" || !this.handshake) return;
    this.clearTimer();
    const approved = this.hooks.responder.approve(this.handshake);
    if (!approved) {
      this.closeSocket("Not approved");
      return;
    }
    if (this.handshake.path === "local-request") {
      this.grantAndClose();
      return;
    }
    this.sendSealed(JSON.stringify({ type: "device_auth_result", ok: true }));
    this.open(this.handshake, approved.pairingUpdate);
  }

  /** A held peer was denied or timed out: it is told once, then the socket closes. */
  deny(): void {
    if (this.state === "held") this.sendSealed(JSON.stringify({ type: "device_auth_result", ok: false, reason: "not_approved" }));
    this.closeSocket("Not approved");
  }

  /** Closes the socket of a removed device. Nothing it sends after this call is read. */
  drop(reason: string): void {
    this.closeSocket(reason);
  }

  private sendSealed(data: string): void {
    const channel = this.handshake?.channel;
    if (!channel || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.binaryEnabled) {
      this.ws.send(channel.sealBinary(Buffer.concat([Uint8Array.of(BIN_MARKER_JSON), Buffer.from(data, "utf8")])), { binary: true });
    } else {
      this.ws.send(JSON.stringify(channel.sealText(data)));
    }
  }

  /** Seals one JSON message at the moment it is written. Nothing leaves before the channel is open. */
  send(data: string): void {
    if (this.state === "open") this.sendSealed(data);
  }

  setClientCapabilities(message: unknown): void {
    this.binaryFileDownloadEnabled = supportsBinaryFileDownload(message);
    this.binaryBrowserFramesEnabled = supportsBinaryBrowserFrames(message);
  }

  private sendBinaryRecord(plaintext: Uint8Array): void {
    const channel = this.handshake?.channel;
    if (channel && this.ws.readyState === WebSocket.OPEN) this.ws.send(channel.sealBinary(plaintext), { binary: true });
  }

  sendBinaryBrowserFrame(encoded: Buffer): boolean {
    if (this.state !== "open" || !this.binaryBrowserFramesEnabled) return false;
    this.sendBinaryRecord(encoded);
    return true;
  }

  supportsBinaryFileDownload(): boolean {
    return this.state === "open" && this.binaryFileDownloadEnabled;
  }

  sendFileDownloadChunk(metadata: BinaryFileDownloadChunkMetadata, bytes: Buffer): boolean {
    if (!this.supportsBinaryFileDownload() || this.ws.readyState !== WebSocket.OPEN) return false;
    this.sendBinaryRecord(encodeBinaryFileDownloadChunk(metadata, bytes));
    return true;
  }
}

/** The direct v2 sockets that are up, so device messages can reach them by key. */
export class DirectV2Sockets {
  private readonly sockets = new Set<DirectV2Transport>();

  add(transport: DirectV2Transport): void {
    this.sockets.add(transport);
  }

  delete(transport: DirectV2Transport): void {
    this.sockets.delete(transport);
  }

  private withKey(publicKey: string): DirectV2Transport[] {
    return [...this.sockets].filter((transport) => transport.peerKey === publicKey);
  }

  /** Whether a socket with this key still waits for Allow. */
  isKeyHeld(publicKey: string): boolean {
    return this.withKey(publicKey).some((transport) => transport.isHeld);
  }

  approveKey(publicKey: string): void {
    for (const transport of this.withKey(publicKey)) transport.approve();
  }

  denyKey(publicKey: string): void {
    for (const transport of this.withKey(publicKey)) transport.deny();
  }

  /** Closes every socket of a key, held or open. */
  dropKey(publicKey: string, reason: string): void {
    for (const transport of this.withKey(publicKey)) transport.drop(reason);
  }

  /** Closes every socket, whatever state its handshake is in. */
  dropAll(reason: string): void {
    for (const transport of [...this.sockets]) transport.drop(reason);
  }

  /** Keys of open channels. */
  openKeys(): string[] {
    return [...this.sockets].flatMap((transport) => (transport.isOpen && transport.peerKey ? [transport.peerKey] : []));
  }

  /** Sends to every open control channel and returns their keys. Used for `pairing_update`. */
  sendToControl(message: Record<string, unknown>): string[] {
    const keys: string[] = [];
    for (const transport of this.sockets) {
      if (!transport.isOpen || transport.lane !== "control" || !transport.peerKey) continue;
      transport.send(JSON.stringify(message));
      keys.push(transport.peerKey);
    }
    return keys;
  }
}
