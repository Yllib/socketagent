import type { DeviceRegistry, DevicePlatform, PairingSecret } from "./device-registry";
import { appPlatformOf } from "./device-registry";
import { verifiedPassKey } from "./account-pass";
import { NoiseError, readMessage1, type NoiseAcceptedMessage1, type NoiseKeyPair } from "./noise-ikpsk1";
import { isRecord } from "./value-guards";
import { isLoopbackAddress } from "./loopback-request";
import {
  approvalCode,
  buildPrologue,
  derivePsk,
  encodeHandshakePayload,
  encodeHs2Frame,
  handshakeAnswer,
  LOCAL_PSK,
  parseHandshakePayload,
  parseHs1Frame,
  secretTag,
  TransportChannel,
  type HandshakeRefusal,
  type Hs1Frame,
} from "./transport-v2";

/**
 * The computer's side of a handshake on transport v2: which secret to try
 * (wire spec 3.5a), who gets in (7.3), and the limits (3.8). The relay
 * client and the direct `?e2e=2` socket both feed it the `hs1` frames they
 * receive and carry out what it answers.
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
 * Three kinds of peer come through here. A device on `control` or `bulk`
 * proves a pairing secret. A linked computer in the link room proves its
 * link secret and only ever gets `open` or silence. A `local-request` peer
 * is the app in another Windows account on this computer: it proves a key
 * and no secret, never gets a channel, and is handed the pairing secret
 * once it is a recorded device (5.3). Session transfer answers its own
 * handshakes in session-transfer.ts.
 */

/**
 * Where an `hs1` arrived. Taken from the socket or room, never from the
 * frame. A direct socket takes `local-request` only from this computer.
 */
export interface Hs1Arrival {
  path: "relay" | "direct" | "local-request";
  lane: "control" | "bulk" | "link";
  /** The remote address of a direct socket. Failed handshakes are counted against it. */
  remoteAddress?: string;
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

/**
 * The admission table of spec 7.3, for a key the handshake has proved.
 * [vouched] means its message 1 carried a pass from an account pass key this
 * computer trusts: such a key is added on a locked computer too, as long as
 * it proved the current secret and was never removed.
 */
export function admissionFor(input: { lane: DeviceLane; standing: KeyStanding; fitted: FittedSecret; locked: boolean; vouched: boolean }): Admission {
  const { lane, standing, fitted, locked, vouched } = input;
  if (standing === "other-kind") return "silent";
  if (standing === "device") return fitted === "previous" && lane === "control" ? "open-update" : "open";
  if (fitted === "previous") return "silent";
  if (lane === "bulk") return "refuse";
  // A removed key that proves the current secret always asks, locked or not.
  if (standing === "removed") return "hold";
  return locked && !vouched ? "hold" : "add";
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
  readonly lane: Hs1Arrival["lane"];
  readonly status: "open" | "pending";
  /** Seals and opens this channel's records. */
  readonly channel: TransportChannel;
  /** The six digits both ends show while the peer waits for Allow. */
  readonly code: string;
  readonly name: string;
  readonly platform: DevicePlatform;
  /** Handled as if a `client_capabilities` message had arrived on this lane. */
  readonly caps: Record<string, unknown>;
  /** The id of the pairing secret the handshake proved. 0 on the link lane and on `local-request`. */
  readonly secretId: number;
  /** The account pass key whose valid pass message 1 carried for this key, if any. Trust is checked separately. */
  readonly passKey?: string;
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
  /** This computer's link room ID, the prologue context for the link lane. Without one, link handshakes get silence. */
  linkRoomId?: () => string;
  serverVersion: string;
  /** A recorded device or linked computer finished its first v2 handshake. Its old-path channels close now. */
  onDeviceMoved?: (publicKey: string) => void;
  now?: () => number;
}

/**
 * How many peers may wait for Allow at once. A captured `hs1` that ended
 * `pending` can be replayed, and each replay takes one of these places for up
 * to ten seconds and one of the thirty answers below. So someone who can see
 * or carry the frames, the relay included, can keep new devices out of the
 * Allow queue. That is accepted: the relay can deny service anyway, and a
 * replay changes no state and shows the owner no device they had not seen.
 */
export const MAX_HELD_PEERS = 8;
/**
 * Failed `hs1` frames one direct remote address may send in a minute. After
 * that the address is ignored for the rest of the minute. A failure costs the
 * computer a few X25519 operations, and the limits exist to bound that work,
 * not guesses at a 32-byte secret.
 */
export const MAX_FAILED_HS1_PER_ADDRESS = 20;
/**
 * Failed `hs1` frames on one lane in a minute, from everyone together. The
 * tag in an `hs1` is public, so anyone in the room or on the network can
 * send frames that fail, and below this cap nobody's failures make the
 * computer skip a good handshake. The key an `hs1` claims shows only after
 * the X25519 work is done, so known devices cannot be let past the cap for
 * free. The cap is set by cost instead: a failed `hs1` takes about a quarter
 * of a millisecond, so 20,000 a minute is at most 5 seconds of processor
 * time, and it takes over 330 frames a second, each on a new connection, to
 * reach it.
 */
export const MAX_FAILED_HS1_PER_LANE = 20_000;
export const MAX_PENDING_ANSWERS = 30;
const PENDING_ANSWER_WINDOW_MS = 10 * 60 * 1000;
const FAILED_HS1_WINDOW_MS = 60 * 1000;
/** Counters kept at once. Past this a new address goes uncounted until old minutes clear. The lane cap still holds. */
const MAX_FAILURE_COUNTERS = 4096;

/** One counter of failed `hs1` frames and how many it allows in a minute. */
interface FailureLimit {
  key: string;
  max: number;
}
const MAX_PSK_TRIES = 4;
/** How long a responder waits for `transport_ready` after `hs2`, and a direct socket for `hs1`. */
export const HANDSHAKE_WAIT_MS = 10 * 1000;
/** How long a held peer waits for Allow before it is told `not_approved`. */
export const HELD_PEER_WAIT_MS = 10 * 60 * 1000;

/** A secret the responder may try against one `hs1`. A null tag fits any `k`. */
interface SecretCandidate {
  id: number;
  tag: string | null;
  psk: () => Uint8Array;
}

/** A key the handshake has proved, with the secret that fitted. */
interface ProvedKey {
  publicKey: string;
  candidate: SecretCandidate;
  accepted: NoiseAcceptedMessage1;
  payload: Record<string, unknown>;
}

function pairingCandidate(secret: PairingSecret): SecretCandidate {
  const bytes = Buffer.from(secret.secret, "base64");
  return { id: secret.id, tag: secretTag(bytes), psk: () => derivePsk(bytes) };
}

function linkCandidate(linkSecret: string): SecretCandidate {
  const bytes = Buffer.from(linkSecret, "base64");
  return { id: 0, tag: secretTag(bytes), psk: () => derivePsk(bytes) };
}

const LOCAL_CANDIDATE: SecretCandidate = { id: 0, tag: null, psk: () => LOCAL_PSK };

export class TransportResponder {
  private readonly held = new Set<AcceptedHandshake>();
  private readonly finished = new WeakSet<AcceptedHandshake>();
  /** The link secret each link handshake proved, checked again at `ready`. */
  private readonly provedLinkSecrets = new WeakMap<AcceptedHandshake, string>();
  /** Failed `hs1` counts for the current minute, by lane (`lane:`) and by direct address (`address:`). */
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

  /**
   * The counters one `hs1` falls under: its lane, and its remote address on
   * a direct socket. A loopback address is not counted by itself, because
   * every program on this computer, and everything behind a proxy on it,
   * shares that address.
   */
  private failureLimits(limitKey: string, remoteAddress: string | undefined): FailureLimit[] {
    const limits: FailureLimit[] = [{ key: `lane:${limitKey}`, max: MAX_FAILED_HS1_PER_LANE }];
    if (remoteAddress && !isLoopbackAddress(remoteAddress)) limits.push({ key: `address:${remoteAddress}`, max: MAX_FAILED_HS1_PER_ADDRESS });
    return limits;
  }

  /** Whether a counter has used up its failed handshakes for the current minute. */
  private skipping(limit: FailureLimit): boolean {
    const window = this.failedHs1.get(limit.key);
    if (!window) return false;
    if (this.now() - window.startedAt >= FAILED_HS1_WINDOW_MS) {
      this.failedHs1.delete(limit.key);
      return false;
    }
    return window.count >= limit.max;
  }

  private noteFailedHs1(limits: readonly FailureLimit[]): void {
    const now = this.now();
    // Addresses come and go, so finished minutes are cleared before the table grows.
    if (this.failedHs1.size >= MAX_FAILURE_COUNTERS) {
      for (const [key, window] of this.failedHs1) if (now - window.startedAt >= FAILED_HS1_WINDOW_MS) this.failedHs1.delete(key);
    }
    for (const { key } of limits) {
      const window = this.failedHs1.get(key);
      if (window && now - window.startedAt < FAILED_HS1_WINDOW_MS) window.count++;
      else if (window || this.failedHs1.size < MAX_FAILURE_COUNTERS || key.startsWith("lane:")) this.failedHs1.set(key, { startedAt: now, count: 1 });
    }
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
   * Steps 2 to 6 of spec 3.5a for one `hs1`. Null means stay silent. The
   * claimed key only picks the candidates. `laneTags` are the tags of every
   * secret the lane could use, and null skips that step.
   */
  private proveKey(input: {
    frame: Hs1Frame;
    limitKey: string;
    remoteAddress?: string;
    prologue: Uint8Array;
    laneTags: readonly string[] | null;
    candidatesFor: (claimedKey: string) => readonly SecretCandidate[];
  }): ProvedKey | null {
    const { frame } = input;
    const limits = this.failureLimits(input.limitKey, input.remoteAddress);
    if (limits.some((limit) => this.skipping(limit))) return null;
    if (input.laneTags && !input.laneTags.includes(frame.tag)) return null;

    let message1: ReturnType<typeof readMessage1>;
    try {
      message1 = readMessage1({ prologue: input.prologue, staticKeyPair: this.options.keyPair(), message: frame.message });
    } catch (err: unknown) {
      if (!(err instanceof NoiseError)) throw err;
      this.noteFailedHs1(limits);
      return null;
    }

    // The key is only a claim here. It chooses which secrets to try.
    const publicKey = Buffer.from(message1.initiatorStaticKey).toString("base64");
    const candidates = input.candidatesFor(publicKey).filter((candidate) => candidate.tag === null || candidate.tag === frame.tag);
    for (const candidate of candidates.slice(0, MAX_PSK_TRIES)) {
      const accepted = message1.tryPsk(candidate.psk());
      if (!accepted) continue;
      // From here the key is proved.
      const payload = parseHandshakePayload(accepted.payload);
      return payload ? { publicKey, candidate, accepted, payload } : null;
    }
    this.noteFailedHs1(limits);
    return null;
  }

  /** Writes message 2 and builds the handshake a transport keeps. */
  private answer(
    proved: ProvedKey,
    arrival: Hs1Arrival,
    status: "open" | "pending" | "refused",
    reason?: HandshakeRefusal,
    passKey?: string,
  ): Hs1Outcome {
    if (status === "pending" && (this.held.size >= MAX_HELD_PEERS || !this.takePendingAnswer())) {
      status = "refused";
      reason = "too_many_pending";
    }
    const answer = proved.accepted.writeMessage2(encodeHandshakePayload(handshakeAnswer(status, this.options.serverVersion, reason)));
    const hs2 = encodeHs2Frame(answer.message2);
    if (status === "refused") return { result: "refused", hs2 };

    const { payload } = proved;
    const handshake: AcceptedHandshake = {
      publicKey: proved.publicKey,
      path: arrival.path,
      lane: arrival.lane,
      status,
      channel: new TransportChannel({ role: "responder", sendKey: answer.sendKey, receiveKey: answer.receiveKey }),
      code: approvalCode(answer.handshakeHash),
      name: typeof payload.name === "string" ? payload.name.trim().slice(0, 80) : "",
      platform: appPlatformOf(payload.platform),
      caps: isRecord(payload.caps) ? payload.caps : {},
      secretId: proved.candidate.id,
      ...(passKey ? { passKey } : {}),
    };
    // Held peers count from hs2, so a replay can fill the table for 10 s at most.
    if (status === "pending") this.held.add(handshake);
    return { result: "answered", hs2, handshake };
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
    const { registry } = this.options;
    if (!registry.readable) return silent;
    if (arrival.lane === "link") return arrival.path === "relay" ? this.handleLinkHs1(frame) : silent;
    if (arrival.path === "local-request") return arrival.lane === "control" ? this.handleLocalRequestHs1(frame) : silent;
    const lane: DeviceLane = arrival.lane;

    const current = registry.currentSecret();
    const secrets = [current, ...registry.previousSecrets()].map(pairingCandidate);
    const proved = this.proveKey({
      frame,
      limitKey: `${arrival.path}:${lane}`,
      remoteAddress: arrival.remoteAddress,
      prologue: buildPrologue(arrival.path, lane, this.options.roomId()),
      laneTags: secrets.flatMap((secret) => secret.tag ?? []),
      candidatesFor: (claimedKey) => {
        const claimed = this.standing(claimedKey);
        return claimed === "device" ? secrets : claimed === "other-kind" ? [] : secrets.slice(0, 1);
      },
    });
    if (!proved) return silent;

    const claimed = this.standing(proved.publicKey);
    // Only a key the record doesn't know yet has any use for a pass.
    const passKey = claimed === "unknown" ? verifiedPassKey(proved.payload.pass, proved.publicKey) ?? undefined : undefined;
    const admission = admissionFor({
      lane, standing: claimed, fitted: proved.candidate.id === current.id ? "current" : "previous", locked: registry.locked,
      vouched: passKey !== undefined && registry.trustsPassKey(passKey),
    });
    if (admission === "silent") return silent;
    if (admission === "refuse") return this.answer(proved, arrival, "refused", "not_approved");
    return this.answer(proved, arrival, admission === "hold" ? "pending" : "open", undefined, passKey);
  }

  /**
   * A linked computer's `hs1` in this computer's link room (spec 5.4). The
   * claimed key must be a recorded computer that has a link secret and has
   * not expired. The answer is `open` or nothing.
   */
  private handleLinkHs1(frame: Hs1Frame): Hs1Outcome {
    const silent: Hs1Outcome = { result: "silent" };
    const linkRoomId = this.options.linkRoomId?.();
    if (!linkRoomId) return silent;
    const { registry } = this.options;
    const linkSecretOf = (publicKey: string): string | undefined => {
      const entry = registry.get(publicKey);
      return entry?.kind === "computer" ? entry.linkSecret : undefined;
    };
    const proved = this.proveKey({
      frame,
      limitKey: "relay:link",
      prologue: buildPrologue("relay", "link", linkRoomId),
      laneTags: registry.list().flatMap((entry) => (entry.kind === "computer" && entry.linkSecret ? [secretTag(Buffer.from(entry.linkSecret, "base64"))] : [])),
      candidatesFor: (claimedKey) => {
        const candidate = linkSecretOf(claimedKey);
        return candidate ? [linkCandidate(candidate)] : [];
      },
    });
    const linkSecret = proved ? linkSecretOf(proved.publicKey) : undefined;
    if (!proved || !linkSecret) return silent;
    const outcome = this.answer(proved, { path: "relay", lane: "link" }, "open");
    if (outcome.result === "answered") this.provedLinkSecrets.set(outcome.handshake, linkSecret);
    return outcome;
  }

  /**
   * An `hs1` on the `local-request` path (spec 5.3), which the caller only
   * passes on from a loopback socket. It proves a key and no secret, so the
   * tag is ignored. A recorded device gets `open` and anything else waits
   * for Allow, locked or not. A linked computer's or AI client's key is not
   * a device and gets silence, as on the device lanes.
   */
  private handleLocalRequestHs1(frame: Hs1Frame): Hs1Outcome {
    const arrival: Hs1Arrival = { path: "local-request", lane: "control" };
    const proved = this.proveKey({
      frame,
      limitKey: "local-request:control",
      prologue: buildPrologue("local-request", "control", ""),
      laneTags: null,
      candidatesFor: () => [LOCAL_CANDIDATE],
    });
    if (!proved) return { result: "silent" };
    const standing = this.standing(proved.publicKey);
    if (standing === "other-kind") return { result: "silent" };
    return this.answer(proved, arrival, standing === "device" ? "open" : "pending");
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
    if (!registry.readable) return this.close(handshake);
    if (handshake.lane === "link") return this.linkReady(handshake);
    if (handshake.path === "local-request") return this.localRequestReady(handshake);
    const now = this.fittedNow(handshake);
    if (!now) return this.close(handshake);
    const { publicKey, name, platform } = handshake;
    // The pass key may have been retired since hs1, so trust is asked again.
    const vouched = handshake.passKey !== undefined && registry.trustsPassKey(handshake.passKey);
    const admission = admissionFor({ lane: handshake.lane, standing: this.standing(publicKey), fitted: now.fitted, locked: registry.locked, vouched });

    if (admission === "hold" && handshake.status === "pending") {
      return { result: "held", notice: { publicKey, name: name || "Unknown device", platform, code: handshake.code } };
    }
    if (handshake.status !== "open") return this.close(handshake);
    if (admission === "add") {
      // "approval" for a key the account vouched for: the user approved it
      // by signing in with Google and the PIN. The field keeps values older
      // servers can read. The record names the pass key that vouched, so it
      // goes when the account retires that key. On an unlocked computer the
      // pairing code alone let the key in, so the pass is not recorded.
      const vouchedBy = vouched && registry.locked ? handshake.passKey : undefined;
      registry.enroll({
        publicKey, kind: "device", name, platform, via: vouchedBy ? "approval" : "token", transport: 2, secretId: now.current.id,
        ...(vouchedBy ? { vouchedBy } : {}),
      });
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

  /**
   * A linked computer's first v2 `transport_ready`. From here its record is
   * on v2 and the old key exchange is refused for its key (spec 10.2).
   */
  private linkReady(handshake: AcceptedHandshake): ReadyOutcome {
    const { registry } = this.options;
    const entry = registry.get(handshake.publicKey);
    const proved = this.provedLinkSecrets.get(handshake);
    if (entry?.kind !== "computer" || !proved || entry.linkSecret !== proved) return this.close(handshake);
    registry.touch(handshake.publicKey, { transport: 2 });
    if (entry.transport === 1) this.options.onDeviceMoved?.(handshake.publicKey);
    return { result: "open" };
  }

  /**
   * `transport_ready` on `local-request`. `open` here means the transport
   * sends `pairing_grant` and closes: the key is a recorded device and has
   * now been handed the current secret. Any other key is held for Allow.
   */
  private localRequestReady(handshake: AcceptedHandshake): ReadyOutcome {
    const { registry } = this.options;
    const { publicKey, name, platform } = handshake;
    const standing = this.standing(publicKey);
    if (standing === "device" && handshake.status === "open") {
      registry.touch(publicKey, { name: name || undefined, platform });
      registry.markSecretHanded([publicKey]);
      return { result: "open" };
    }
    if (standing === "device" || standing === "other-kind" || handshake.status !== "pending") return this.close(handshake);
    return { result: "held", notice: { publicKey, name: name || "Unknown device", platform, code: handshake.code } };
  }

  private close(handshake: AcceptedHandshake): ReadyOutcome {
    this.held.delete(handshake);
    return { result: "closed" };
  }

  /**
   * A paired device allowed this held peer, and the index has recorded its
   * key. Marks the record as v2, except on `local-request`, where the
   * transport sends `pairing_grant` next and closes. Null when the key is
   * not a recorded device after all, and the transport then drops the peer.
   */
  approve(handshake: AcceptedHandshake): { pairingUpdate?: PairingUpdate } | null {
    this.held.delete(handshake);
    const { registry } = this.options;
    if (!registry.readable || this.standing(handshake.publicKey) !== "device") return null;
    if (handshake.path === "local-request") {
      // The grant hands over the current secret. The record moves to v2 when
      // the device comes back with an ordinary direct handshake.
      registry.markSecretHanded([handshake.publicKey]);
      return {};
    }
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
