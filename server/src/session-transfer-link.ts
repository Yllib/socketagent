import { initiateHandshake, NoiseError, readMessage1, type NoiseInitiatorHandshake, type NoiseKeyPair } from "./noise-ikpsk1";
import {
  buildPrologue,
  derivePsk,
  encodeBinaryHs1,
  encodeBinaryHs2,
  encodeHandshakePayload,
  encodeTransferRecord,
  handshakeAnswer,
  isBinaryHandshakeFrame,
  parseBinaryHs1,
  parseBinaryHs2,
  parseHandshakePayload,
  RecordError,
  secretTag,
  TransportChannel,
  TRANSPORT_READY_MESSAGE,
} from "./transport-v2";

/** How long the source waits for `hs2`, and the destination for `transport_ready`. */
const HANDSHAKE_WAIT_MS = 10_000;

export interface TransferLinkOptions {
  role: "source" | "destination";
  jobId: string;
  /** This computer's static X25519 key pair. */
  keyPair: NoiseKeyPair;
  /** The other computer's static key, from the job's `peerPublicKey`. */
  peerPublicKey: Uint8Array;
  /** The job's transfer secret, 32 bytes. */
  transferSecret: Uint8Array;
  /** This server's release version, sent in the handshake. */
  serverVersion: string;
  sendFrame: (frame: Buffer) => void;
  /** The channel is up and this side may send its first job message. */
  onOpen: () => void;
  /** The handshake or a record failed. The caller closes the socket and dials again. */
  onBroken: (why: string) => void;
}

/**
 * The transport v2 channel of one session-transfer socket (wire spec 5.5).
 * The job that has a transfer secret puts every frame through this and never
 * opens a static-box frame.
 *
 * How the job uses it:
 *
 *   1. `peerReady()` on every `peer_ready` from the relay. Both sides drop
 *      any channel. The source sends the binary `hs1`.
 *   2. `receive(frame)` for every binary frame. Handshake frames are
 *      consumed here and it returns null. A record from the open channel
 *      comes back as its plaintext, `[4-byte header length][JSON][bytes]`.
 *   3. `seal(plaintext)` for every record the job sends. Null while no
 *      channel is open, and the job then sends nothing.
 *   4. `close()` when the socket goes away.
 *
 * The destination answers `hs1` only when the initiator's key is the job's
 * `peerPublicKey` and the handshake proves the transfer secret. It answers
 * `open` or stays silent, and counts the channel as open at the source's
 * first record, `transport_ready`.
 */
export class TransferLink {
  private channel: TransportChannel | null = null;
  /** The destination has answered `hs1` and waits for `transport_ready`. */
  private awaitingReady = false;
  /** The source's handshake in flight. */
  private handshake: NoiseInitiatorHandshake | null = null;
  /** One handshake per `peer_ready`. A second `hs1` is ignored. */
  private handshakeUsed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly prologue: Buffer;
  private readonly tag: string;

  constructor(private readonly options: TransferLinkOptions) {
    this.prologue = buildPrologue("relay", "transfer", options.jobId);
    this.tag = secretTag(options.transferSecret);
  }

  /** Whether records can be sent and received. */
  get open(): boolean {
    return this.channel !== null && !this.awaitingReady;
  }

  private setTimer(onTimeout: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(onTimeout, HANDSHAKE_WAIT_MS);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private reset(): void {
    this.clearTimer();
    this.channel = null;
    this.awaitingReady = false;
    this.handshake = null;
    this.handshakeUsed = false;
  }

  close(): void {
    this.reset();
  }

  private broken(why: string): void {
    this.reset();
    // A used-up handshake stays used until the next peer_ready.
    this.handshakeUsed = true;
    this.options.onBroken(why);
  }

  /** The relay says both computers are on the socket. Any earlier channel is gone. */
  peerReady(): void {
    this.reset();
    if (this.options.role !== "source") return;
    this.handshakeUsed = true;
    this.handshake = initiateHandshake({
      prologue: this.prologue,
      staticKeyPair: this.options.keyPair,
      responderStaticKey: this.options.peerPublicKey,
      psk: derivePsk(this.options.transferSecret),
      payload: encodeHandshakePayload({ app: this.options.serverVersion }),
    });
    this.options.sendFrame(encodeBinaryHs1(this.tag, this.handshake.message1));
    this.setTimer(() => this.broken("The other computer did not answer the transfer handshake"));
  }

  /** One binary frame from the socket. Returns a record's plaintext, or null when there is nothing for the job. */
  receive(frame: Buffer): Buffer | null {
    if (isBinaryHandshakeFrame(frame)) {
      if (this.options.role === "source") this.readHs2(frame);
      else this.answerHs1(frame);
      return null;
    }
    // A record with no channel to open it is dropped. This is where a
    // static-box frame for this job ends up.
    if (!this.channel) return null;
    let plaintext: Buffer;
    try {
      plaintext = Buffer.from(this.channel.openBinary(frame));
    } catch (err: unknown) {
      if (!(err instanceof RecordError)) throw err;
      this.broken(err.message);
      return null;
    }
    if (!this.awaitingReady) return plaintext;
    // The destination's side effects wait for this record (spec 3.7).
    if (!plaintext.equals(encodeTransferRecord(TRANSPORT_READY_MESSAGE))) {
      this.broken("The first transfer record was not transport_ready");
      return null;
    }
    this.clearTimer();
    this.awaitingReady = false;
    this.options.onOpen();
    return null;
  }

  /** Seals one record, or null while no channel is open. */
  seal(plaintext: Uint8Array): Buffer | null {
    return this.channel && !this.awaitingReady ? this.channel.sealBinary(plaintext) : null;
  }

  /** Destination: steps 1 to 6 of spec 3.5a for the transfer lane. Anything wrong is silent. */
  private answerHs1(frame: Buffer): void {
    if (this.handshakeUsed) return;
    this.handshakeUsed = true;
    const hs1 = parseBinaryHs1(frame);
    if (!hs1 || hs1.tag !== this.tag) return;
    let accepted: ReturnType<ReturnType<typeof readMessage1>["tryPsk"]>;
    try {
      const message1 = readMessage1({ prologue: this.prologue, staticKeyPair: this.options.keyPair, message: hs1.message });
      // The key is a claim until the PSK fits. It must be the job's other computer.
      if (!Buffer.from(message1.initiatorStaticKey).equals(Buffer.from(this.options.peerPublicKey))) return;
      accepted = message1.tryPsk(derivePsk(this.options.transferSecret));
    } catch (err: unknown) {
      if (err instanceof NoiseError) return;
      throw err;
    }
    if (!accepted || !parseHandshakePayload(accepted.payload)) return;
    const answer = accepted.writeMessage2(encodeHandshakePayload(handshakeAnswer("open", this.options.serverVersion)));
    this.channel = new TransportChannel({ role: "responder", sendKey: answer.sendKey, receiveKey: answer.receiveKey });
    this.awaitingReady = true;
    this.options.sendFrame(encodeBinaryHs2(answer.message2));
    // Without transport_ready the keys are dropped. The source dials again.
    this.setTimer(() => { this.channel = null; this.awaitingReady = false; });
  }

  /** Source: the first `hs2` decides the handshake (spec 3.7). */
  private readHs2(frame: Buffer): void {
    const handshake = this.handshake;
    if (!handshake) return;
    this.handshake = null;
    this.clearTimer();
    const message2 = parseBinaryHs2(frame);
    if (!message2) {
      this.broken("The other computer answered with an unusable transfer handshake");
      return;
    }
    let keys: ReturnType<NoiseInitiatorHandshake["readMessage2"]>;
    try {
      keys = handshake.readMessage2(message2);
    } catch (err: unknown) {
      if (!(err instanceof NoiseError)) throw err;
      this.broken("The other computer answered with an unusable transfer handshake");
      return;
    }
    if (parseHandshakePayload(keys.payload)?.status !== "open") {
      this.broken("The other computer refused the transfer handshake");
      return;
    }
    this.channel = new TransportChannel({ role: "initiator", sendKey: keys.sendKey, receiveKey: keys.receiveKey });
    this.options.sendFrame(this.channel.sealBinary(encodeTransferRecord(TRANSPORT_READY_MESSAGE)));
    this.options.onOpen();
  }
}
