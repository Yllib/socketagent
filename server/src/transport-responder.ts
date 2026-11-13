import type { DeviceRegistry, DevicePlatform, PairingSecret } from "./device-registry";
import { NoiseError, readMessage1, type NoiseKeyPair } from "./noise-ikpsk1";
import { isRecord } from "./value-guards";
import {
  approvalCode,
  buildPrologue,
  derivePsk,
  encodeHandshakePayload,
  encodeHs2Frame,
  handshakeAnswer,
  parseHandshakePayload,
  parseHs1Frame,
  secretTag,
  TransportChannel,
  type HandshakeRefusal,
} from "./transport-v2";

/**
 * The computer's side of a device handshake on transport v2: which pairing
 * secret to try (wire spec 3.5a), who gets in (7.3), and the limits (3.8).
 * The relay client and the direct `?e2e=2` socket both feed it the `hs1`
 * frames they receive and carry out what it answers.
 *
 * How a transport uses it:
 *
 *   1. `handleHs1(raw, arrival)` for the first `hs1` of a relay peer or
 *      socket. `silent` means send nothing. `refused` means send `hs2` and
 *      forget the peer. `answered` means send `hs2`, keep the handshake, and
 *      wait up to 10 s for the first record.
 *   2. Open the first record with `handshake.channel`. When it is
 *      `transport_ready`, call `ready(handshake)`. This is the one point where
 *      the state file may change (3.7): a replayed `hs1` gets a fresh `hs2`
 *      but can never produce that record, so it never reaches `ready`.
 *   3. `ready` says `open`, `held` or `closed`. A held peer waits for
 *      `approve(handshake)` after the index has recorded its key.
 *   4. `release(handshake)` whenever the peer goes away or times out.
 *
 * Link, transfer and `local-request` handshakes are not answered here yet.
 */

/** Where an `hs1` arrived. Taken from the socket or room, never from the frame. */
export interface Hs1Arrival {
  path: "relay" | "direct";
  lane: "control" | "bulk" | "link";
}

export type DeviceLane = "control" | "bulk";

/** What the record says about a key. */
export type KeyStanding = "device" | "other-kind" | "removed" | "unknown";
/** Which stored secret the handshake proved. */
export type FittedSecret = "current" | "previous";
/**
 * The row of the table in spec 7.3 a proved key lands on. `open-update` is
 * rule 4: open, then `pairing_update` first. `add` is rule 7. `hold` is rules
 * 5 and 8. `refuse` is the bulk lane's answer to a key that control would add
 * or hold.
 */
export type Admission = "open" | "open-update" | "add" | "hold" | "refuse" | "silent";

/** The admission table of spec 7.3, for a key the handshake has proved. */
export function admissionFor(input: { lane: DeviceLane; standing: KeyStanding; fitted: FittedSecret; locked: boolean }): Admission {
  const { lane, standing, fitted, locked } = input;
  if (standing === "other-kind") return "silent";
  if (standing === "device") return fitted === "previous" && lane === "control" ? "open-update" : "open";
  if (fitted === "previous") return "silent";
  if (lane === "bulk") return "refuse";
  // A removed key that proves the current secret always asks, locked or not.
  if (standing === "removed") return "hold";
  return locked ? "hold" : "add";
}

export type PairingUpdate = {
  type: "pairing_update";
  secret: string;
  roomId: string;
};

export interface PendingNotice {
  publicKey: string;
  name: string;
  platform: DevicePlatform;
  code: string;
}

/** A handshake the computer answered with `open` or `pending`. Nothing is stored for it until `ready`. */
export interface AcceptedHandshake {
  /** The initiator's static key, base64. Proved by the handshake. */
  readonly publicKey: string;
  readonly path: Hs1Arrival["path"];
  readonly lane: DeviceLane;
  readonly status: "open" | "pending";
  /** Seals and opens this channel's records. */
  readonly channel: TransportChannel;
  /** The six digits both ends show while the peer waits for Allow. */
  readonly code: string;
  readonly name: string;
  readonly platform: DevicePlatform;
  /** Handled as if a `client_capabilities` message had arrived on this lane. */
  readonly caps: Record<string, unknown>;
  /** The id of the pairing secret the handshake proved. */
  readonly secretId: number;
}

export type Hs1Outcome =
  | { result: "silent" }
  | { result: "refused"; hs2: string }
  | { result: "answered"; hs2: string; handshake: AcceptedHandshake };

export type ReadyOutcome =
  | { result: "open"; pairingUpdate?: PairingUpdate }
  | { result: "held"; notice: PendingNotice }
  | { result: "closed" };

export interface TransportResponderOptions {
  registry: DeviceRegistry;
  /** The computer's static X25519 key pair. */
  keyPair: () => NoiseKeyPair;
  /** The control room ID, which is the prologue context for control and bulk. */
  roomId: () => string;
  serverVersion: string;
  /** A recorded device finished its first v2 handshake. Its old-path channels close now. */
  onDeviceMoved?: (publicKey: string) => void;
  now?: () => number;
}

export const MAX_HELD_PEERS = 8;
export const MAX_FAILED_HS1_PER_MINUTE = 20;
export const MAX_PENDING_ANSWERS = 30;
const PENDING_ANSWER_WINDOW_MS = 10 * 60 * 1000;
const FAILED_HS1_WINDOW_MS = 60 * 1000;
const MAX_PSK_TRIES = 4;
/** How long a responder waits for `transport_ready` after `hs2`, and a direct socket for `hs1`. */
export const HANDSHAKE_WAIT_MS = 10 * 1000;
/** How long a held peer waits for Allow before it is told `not_approved`. */
export const HELD_PEER_WAIT_MS = 10 * 60 * 1000;

const DEVICE_PLATFORMS: readonly DevicePlatform[] = ["android", "windows", "linux", "macos", "ios"];

export class TransportResponder {
  private readonly held = new Set<AcceptedHandshake>();
  private readonly finished = new WeakSet<AcceptedHandshake>();
  private readonly failedHs1 = new Map<string, { startedAt: number; count: number }>();
  private pendingAnswers: number[] = [];

  constructor(private readonly options: TransportResponderOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private standing(publicKey: string): KeyStanding {
    const { registry } = this.options;
    if (registry.isRevoked(publicKey)) return "removed";
    const entry = registry.get(publicKey);
    if (!entry) return "unknown";
    return entry.kind === "device" ? "device" : "other-kind";
  }

  /** Whether this lane has used up its failed handshakes for the current minute. */
  private skipping(lane: string): boolean {
    const window = this.failedHs1.get(lane);
    if (!window) return false;
    if (this.now() - window.startedAt >= FAILED_HS1_WINDOW_MS) {
      this.failedHs1.delete(lane);
      return false;
    }
    return window.count >= MAX_FAILED_HS1_PER_MINUTE;
  }

  private noteFailedHs1(lane: string): Hs1Outcome {
    const window = this.failedHs1.get(lane);
    if (window) window.count++;
    else this.failedHs1.set(lane, { startedAt: this.now(), count: 1 });
    return { result: "silent" };
  }

  /** Counts one `pending` answer. False once the computer has given 30 in ten minutes. */
  private takePendingAnswer(): boolean {
    const oldest = this.now() - PENDING_ANSWER_WINDOW_MS;
    this.pendingAnswers = this.pendingAnswers.filter((at) => at > oldest);
    if (this.pendingAnswers.length >= MAX_PENDING_ANSWERS) return false;
    this.pendingAnswers.push(this.now());
    return true;
  }

  /** The current pairing secret as the message a device stores. */
  pairingUpdate(): PairingUpdate {
    return { type: "pairing_update", secret: this.options.registry.currentSecret().secret, roomId: this.options.roomId() };
  }

  /**
   * Reads an `hs1` text frame and decides the answer. Reads the state file's
   * contents and counts against the in-memory limits. Changes nothing else.
   */
  handleHs1(raw: string, arrival: Hs1Arrival): Hs1Outcome {
    const silent: Hs1Outcome = { result: "silent" };
    const frame = parseHs1Frame(raw);
    // The prologue comes from where the frame arrived. A frame that claims
    // another path or lane could only fail, so it is not tried.
    if (!frame || frame.path !== arrival.path || frame.lane !== arrival.lane) return silent;
    if (arrival.lane === "link") return silent;
    const lane: DeviceLane = arrival.lane;
    const { registry } = this.options;
    if (!registry.readable) return silent;
    const limitKey = `${arrival.path}:${lane}`;
    if (this.skipping(limitKey)) return silent;

    const current = registry.currentSecret();
    const secrets = [current, ...registry.previousSecrets()].map((secret) => {
      const bytes = Buffer.from(secret.secret, "base64");
      return { id: secret.id, bytes, tag: secretTag(bytes) };
    });
    if (!secrets.some((secret) => secret.tag === frame.tag)) return silent;

    let message1: ReturnType<typeof readMessage1>;
    try {
      message1 = readMessage1({
        prologue: buildPrologue(arrival.path, lane, this.options.roomId()),
        staticKeyPair: this.options.keyPair(),
        message: frame.message,
      });
    } catch (err: unknown) {
      if (err instanceof NoiseError) return this.noteFailedHs1(limitKey);
      throw err;
    }

    // The key is only a claim here. It chooses which secrets to try.
    const publicKey = Buffer.from(message1.initiatorStaticKey).toString("base64");
    const claimed = this.standing(publicKey);
    const candidates = claimed === "device" ? secrets : claimed === "other-kind" ? [] : secrets.slice(0, 1);
    let fitted: { id: number; accepted: NonNullable<ReturnType<typeof message1.tryPsk>> } | undefined;
    for (const candidate of candidates.filter((secret) => secret.tag === frame.tag).slice(0, MAX_PSK_TRIES)) {
      const accepted = message1.tryPsk(derivePsk(candidate.bytes));
      if (accepted) {
        fitted = { id: candidate.id, accepted };
        break;
      }
    }
    if (!fitted) return this.noteFailedHs1(limitKey);

    // From here the key is proved.
    const payload = parseHandshakePayload(fitted.accepted.payload);
    if (!payload) return silent;
    const admission = admissionFor({
      lane, standing: claimed, fitted: fitted.id === current.id ? "current" : "previous", locked: registry.locked,
    });
    if (admission === "silent") return silent;

    let status: "open" | "pending" | "refused" = admission === "hold" ? "pending" : admission === "refuse" ? "refused" : "open";
    let reason: HandshakeRefusal | undefined = admission === "refuse" ? "not_approved" : undefined;
    if (status === "pending" && (this.held.size >= MAX_HELD_PEERS || !this.takePendingAnswer())) {
      status = "refused";
      reason = "too_many_pending";
    }
    const answer = fitted.accepted.writeMessage2(encodeHandshakePayload(handshakeAnswer(status, this.options.serverVersion, reason)));
    const hs2 = encodeHs2Frame(answer.message2);
    if (status === "refused") return { result: "refused", hs2 };

    const platform = DEVICE_PLATFORMS.find((candidate) => candidate === payload.platform) ?? "android";
    const handshake: AcceptedHandshake = {
      publicKey,
      path: arrival.path,
      lane,
      status,
      channel: new TransportChannel({ role: "responder", sendKey: answer.sendKey, receiveKey: answer.receiveKey }),
      code: approvalCode(answer.handshakeHash),
      name: typeof payload.name === "string" ? payload.name.trim().slice(0, 80) : "",
      platform,
      caps: isRecord(payload.caps) ? payload.caps : {},
      secretId: fitted.id,
    };
    // Held peers count from hs2, so a replay can fill the table for 10 s at most.
    if (status === "pending") this.held.add(handshake);
    return { result: "answered", hs2, handshake };
  }

  /** Which stored secret the handshake proved, as the state stands now. */
  private fittedNow(handshake: AcceptedHandshake): { fitted: FittedSecret; current: PairingSecret } | null {
    const { registry } = this.options;
    const current = registry.currentSecret();
    if (handshake.secretId === current.id) return { fitted: "current", current };
    return registry.previousSecrets().some((secret) => secret.id === handshake.secretId) ? { fitted: "previous", current } : null;
  }

  /**
   * The peer's first record was `transport_ready`, so it holds the keys of
   * this handshake. The admission rule runs again on the state as it is now,
   * and only here is anything stored. `closed` means the state changed under
   * the handshake since `hs2`: the transport drops the peer and it dials again.
   */
  ready(handshake: AcceptedHandshake): ReadyOutcome {
    const closed: ReadyOutcome = { result: "closed" };
    if (this.finished.has(handshake)) return closed;
    this.finished.add(handshake);
    const { registry } = this.options;
    const now = registry.readable ? this.fittedNow(handshake) : null;
    if (!now) return this.close(handshake);
    const { publicKey, name, platform } = handshake;
    const admission = admissionFor({ lane: handshake.lane, standing: this.standing(publicKey), fitted: now.fitted, locked: registry.locked });

    if (admission === "hold" && handshake.status === "pending") {
      return { result: "held", notice: { publicKey, name: name || "Unknown device", platform, code: handshake.code } };
    }
    if (handshake.status !== "open") return this.close(handshake);
    if (admission === "add") {
      registry.enroll({ publicKey, kind: "device", name, platform, via: "token", transport: 2, secretId: now.current.id });
      return { result: "open" };
    }
    if (admission !== "open" && admission !== "open-update") return this.close(handshake);

    const moved = registry.get(publicKey)?.transport === 1;
    // On control a device under a previous secret is handed the current one
    // next, so the record names that one.
    const secretId = admission === "open-update" ? now.current.id : handshake.secretId;
    registry.touch(publicKey, { name: name || undefined, platform, transport: 2, secretId });
    if (moved) this.options.onDeviceMoved?.(publicKey);
    return admission === "open-update" ? { result: "open", pairingUpdate: this.pairingUpdate() } : { result: "open" };
  }

  private close(handshake: AcceptedHandshake): ReadyOutcome {
    this.held.delete(handshake);
    return { result: "closed" };
  }

  /**
   * A paired device allowed this held peer, and the index has recorded its
   * key. Marks the record as v2. Null when the key is not a recorded device
   * after all, and the transport then drops the peer.
   */
  approve(handshake: AcceptedHandshake): { pairingUpdate?: PairingUpdate } | null {
    this.held.delete(handshake);
    const { registry } = this.options;
    if (!registry.readable || this.standing(handshake.publicKey) !== "device") return null;
    const current = registry.currentSecret();
    const moved = registry.get(handshake.publicKey)?.transport === 1;
    registry.touch(handshake.publicKey, { transport: 2, secretId: current.id });
    if (moved) this.options.onDeviceMoved?.(handshake.publicKey);
    // The secret may have changed while the peer waited.
    return handshake.secretId === current.id ? {} : { pairingUpdate: this.pairingUpdate() };
  }

  /** The peer left, timed out or was denied. Frees its place among the held peers. */
  release(handshake: AcceptedHandshake): void {
    this.finished.add(handshake);
    this.held.delete(handshake);
  }

  /** How many peers are held or still inside their 10 s after a `pending` answer. */
  get heldCount(): number {
    return this.held.size;
  }
}

/** Whether a peer's first record is the `transport_ready` every v2 channel starts with. */
export function isTransportReady(plaintext: string): boolean {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    return isRecord(parsed) && parsed.type === "transport_ready";
  } catch {
    return false;
  }
}
