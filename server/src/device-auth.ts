import { DeviceEntry, DeviceRegistry, DevicePlatform, deviceFingerprint, appPlatformOf } from "./device-registry";
import { constantTimeEqual } from "./secret-compare";
import { isLoopbackAddress } from "./loopback-request";

/** Relay lanes. Device keys use control and bulk; computer keys use link only. */
export type RelayLane = "control" | "bulk" | "link";

export interface DeviceAuthRequest {
  token?: string;
  name?: string;
  platform?: DevicePlatform;
}

export type DeviceAuthReason =
  | "approval_required"
  | "not_approved"
  | "wrong_lane"
  | "too_many_attempts"
  | "too_many_pending"
  | "removed";

/**
 * What a key gets right after an old-path key exchange. `pending` means it
 * is unknown and may still send the token in `device_auth`. `refused` is
 * told the reason once and then ignored.
 */
export type PeerAdmission =
  | { admission: "approved" }
  | { admission: "pending" }
  | { admission: "refused"; reason: DeviceAuthReason };

export type DeviceAuthOutcome =
  | { ok: true; enrolled: boolean }
  | {
      ok: false;
      reason: DeviceAuthReason;
      /** Fingerprint shown on both devices while approval is pending. */
      code?: string;
      /** The peer should be dropped after this reply. */
      close?: boolean;
      /** Paired devices should be told about this pending key. */
      notify?: { publicKey: string; name: string; platform: DevicePlatform; code: string };
    };

const WRONG_TOKEN_LIMIT = 5;
const WRONG_TOKEN_WINDOW_MS = 10 * 60 * 1000;
/** Counters kept at once. A sender can make a new key for every try, so the table is bounded. */
const MAX_WRONG_TOKEN_COUNTERS = 4096;

const NOT_APPROVED: DeviceAuthOutcome = { ok: false, reason: "not_approved", close: true };


/**
 * The old path's admission rules, kept under the lid of wire spec section 9
 * until that path is deleted. It decides for a key that arrived by
 * `key_exchange` over the relay or on an `e2e=1` direct socket. A v2
 * handshake never comes here; its rules are in transport-responder.ts.
 *
 * What still gets in: a recorded key on its own lane, and an unknown device
 * key that sends the right AUTH_TOKEN inside the encrypted channel. Over the
 * relay the token only counts while the computer is not locked. On a direct
 * socket it counts locked or not. What no longer gets in: a removed key, a
 * key that has moved to v2, and an unknown key without the token. Nothing is
 * enrolled on sight and no relay peer raises an approval prompt.
 */
export class DeviceAuthGate {
  private wrongTokens = new Map<string, number[]>();

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly currentToken: () => string,
  ) {}

  /** Why a key may not use the old path at all, whatever it sends next. */
  private barred(publicKey: string, lane: RelayLane): DeviceAuthReason | null {
    // An unreadable state file admits nobody over the relay or the LAN.
    if (!this.registry.readable) return "not_approved";
    if (this.registry.isRevoked(publicKey)) return "removed";
    const entry = this.registry.get(publicKey);
    if (lane === "link") return entry?.kind === "computer" && entry.transport === 1 ? null : "wrong_lane";
    if (entry && entry.kind !== "device") return "wrong_lane";
    // A device that has moved to v2 does not come back.
    if (entry?.transport === 2) return "not_approved";
    return null;
  }

  /** Admission for a key that just finished an old-path key exchange on `lane`. */
  authorize(publicKey: string, lane: RelayLane): PeerAdmission {
    const reason = this.barred(publicKey, lane);
    if (reason) return { admission: "refused", reason };
    if (!this.registry.get(publicKey)) return { admission: "pending" };
    this.registry.touch(publicKey);
    return { admission: "approved" };
  }

  /**
   * Handles an encrypted `device_auth` from a relay peer on `lane`. A
   * recorded device may send it to update its name. An unknown key gets in
   * only with the right token on an unlocked computer, and is otherwise told
   * `not_approved` and dropped.
   */
  deviceAuth(publicKey: string, lane: RelayLane, request: DeviceAuthRequest, peerId?: string): DeviceAuthOutcome {
    if (lane === "link") return { ok: false, reason: "wrong_lane", close: true };
    return this.admit(publicKey, request, "relay", false, peerId ? `relay:${lane}:${peerId}` : undefined);
  }

  /**
   * Handles `direct_auth` on an `e2e=1` direct socket, where the key exchange
   * already proved `publicKey`. A recorded device needs no token. An unknown
   * key gets in with the right token, locked or not: released apps that only
   * ever connected this way were never recorded, and they must keep working
   * until the old path is shut down.
   *
   * That is more than being let in once. The key is recorded as a device, so
   * from then on it gets in over the relay with no token, and `pairing_upgrade`
   * hands it the pairing secret, which carries it over to transport v2 for
   * good. On a locked computer, AUTH_TOKEN and reach of the port therefore
   * make a lasting device with no Allow. Only while the old path is
   * switched on (SOCKETAGENT_LEGACY_TRANSPORT=on).
   *
   * A socket from this computer, which is
   * loopback with no proxy in front, may also send no token and raise an
   * approval prompt, for the old desktop app under another Windows account.
   */
  directAuth(publicKey: string, request: DeviceAuthRequest, fromThisComputer: boolean, remoteAddress?: string): DeviceAuthOutcome {
    // Every program on this computer shares the loopback address, so it is no source to count.
    return this.admit(publicKey, request, "direct", fromThisComputer, remoteAddress && !isLoopbackAddress(remoteAddress) ? `direct:${remoteAddress}` : undefined);
  }

  /**
   * [source] is where the request came from, in a form the sender cannot
   * pick: the relay peer or the direct remote address. Wrong tokens are
   * counted against it as well as against the key, which the sender does pick.
   */
  private admit(publicKey: string, request: DeviceAuthRequest, path: "relay" | "direct", fromThisComputer: boolean, source?: string): DeviceAuthOutcome {
    if (!this.registry.readable) {
      // Nothing can be recorded or looked up. This computer's own tools still
      // get in by the token, and nobody else does.
      const local = fromThisComputer && typeof request.token === "string" && constantTimeEqual(request.token, this.currentToken());
      return local ? { ok: true, enrolled: false } : NOT_APPROVED;
    }
    const reason = this.barred(publicKey, "control");
    if (reason) return { ok: false, reason, close: true };
    const name = (request.name || "").trim().slice(0, 80);
    const platform = request.platform === undefined ? undefined : appPlatformOf(request.platform);
    if (this.registry.get(publicKey)) {
      this.registry.touch(publicKey, { name: name || undefined, platform });
      return { ok: true, enrolled: false };
    }
    if (typeof request.token === "string" && request.token) {
      const counters = [`key:${publicKey}`, ...(source ? [`from:${source}`] : [])];
      // Past the limit no token is looked at, so a guess learns nothing.
      if (counters.some((counter) => this.spent(counter))) return { ok: false, reason: "too_many_attempts", close: true };
      if (!constantTimeEqual(request.token, this.currentToken())) {
        this.noteWrongToken(counters);
        return NOT_APPROVED;
      }
      // The lock holds on the relay, where every device that exists is
      // already on record. A direct token holder was never recorded by the
      // old build, so refusing it here would lock out a device paired today.
      // The record made below lasts and can carry over to v2: see directAuth.
      if (this.registry.locked && path === "relay") return NOT_APPROVED;
      this.registry.enroll({ publicKey, kind: "device", name, platform: platform || "android", via: "token" });
      this.wrongTokens.delete(`key:${publicKey}`);
      return { ok: true, enrolled: true };
    }
    if (!fromThisComputer) return NOT_APPROVED;
    const code = deviceFingerprint(publicKey);
    return {
      ok: false, reason: "approval_required", code,
      notify: { publicKey, name: name || "Unknown device", platform: platform || "android", code },
    };
  }

  /**
   * Checks the token a direct upgrade request carries, where [right] says
   * whether it is the current one. False for a wrong token, and for any
   * token while [remoteAddress] has used up its wrong tries. The count is
   * the one `direct_auth` from that address uses. Loopback is not counted.
   */
  upgradeToken(right: boolean, remoteAddress: string | undefined): boolean {
    if (!remoteAddress || isLoopbackAddress(remoteAddress)) return right;
    const counter = `from:direct:${remoteAddress}`;
    if (this.spent(counter)) return false;
    if (!right) this.noteWrongToken([counter]);
    return right;
  }

  /** The wrong tokens counted against [counter] in the last ten minutes. */
  private recentWrongTokens(counter: string): number[] {
    const now = Date.now();
    return (this.wrongTokens.get(counter) || []).filter((at) => now - at < WRONG_TOKEN_WINDOW_MS);
  }

  /**
   * Whether [counter] has had five wrong tokens in the last ten minutes.
   * While it has, every token it sends is refused unread, the right one
   * too, until the oldest of the five is ten minutes old. A refusal is not
   * counted, so the wait does not grow.
   */
  private spent(counter: string): boolean {
    return this.recentWrongTokens(counter).length >= WRONG_TOKEN_LIMIT;
  }

  /** Counts one wrong token against each of [counters]: the key, and where it came from. */
  private noteWrongToken(counters: readonly string[]): void {
    const now = Date.now();
    if (this.wrongTokens.size >= MAX_WRONG_TOKEN_COUNTERS) {
      for (const [counter, times] of this.wrongTokens) if (times.every((at) => now - at >= WRONG_TOKEN_WINDOW_MS)) this.wrongTokens.delete(counter);
    }
    for (const counter of counters) {
      const recent = [...this.recentWrongTokens(counter), now];
      if (this.wrongTokens.has(counter) || this.wrongTokens.size < MAX_WRONG_TOKEN_COUNTERS) this.wrongTokens.set(counter, recent);
    }
  }
}

/**
 * The `vouchedBy` a record takes from the device that makes it, by Allow or
 * by linking a computer. [maker] is that device's key, or undefined for a
 * client on this computer itself. Undefined means the new record is not
 * marked: its maker came in by the pairing code, or is no recorded device.
 */
export function inheritedVouchedBy(registry: DeviceRegistry, maker: string | undefined): string | undefined {
  const by = maker ? registry.get(maker) : undefined;
  return by?.kind === "device" ? by.vouchedBy : undefined;
}

/**
 * Records the device key a `device_approve` names. [waiting] is set when the
 * key is held for an answer: its owner was shown a code for it, and the
 * record is made as it always was. A key already on record keeps its
 * transport.
 *
 * A key nobody has seen, as an account invite names, is recorded by how its
 * approver is connected. [approverOnV2] says the approval came in on a
 * transport v2 channel. That approver's app writes the pairing secret into
 * the account vault, so the record is made on transport 2 only: the invited
 * device gets in once it proves the secret in a handshake, and the old path
 * refuses it. An approver on the old path writes a vault with AUTH_TOKEN and
 * no pairing secret, so the invited device has only the old path to come in
 * by, and the record is made there for it to carry over from.
 *
 * [approver] is the device key the approval came from, when it has one. A
 * new record takes that device's `vouchedBy`: what a device that a pass let
 * in approves goes with it when its account retires that pass key, and what
 * those approve in turn. A key already on record keeps what it has.
 */
export function recordApprovedDevice(
  registry: DeviceRegistry,
  approval: { publicKey: string; name: string; approverOnV2: boolean; approver?: string; waiting?: { name: string; platform: DevicePlatform } },
): DeviceEntry {
  const { publicKey, waiting } = approval;
  const existing = registry.get(publicKey);
  const vouchedBy = inheritedVouchedBy(registry, approval.approver);
  return registry.enroll({
    publicKey, kind: "device", via: "approval",
    name: approval.name || waiting?.name || existing?.name || "",
    platform: waiting?.platform || existing?.platform || "android",
    ...(approval.approverOnV2 && !waiting && !existing ? { transport: 2 } : {}),
    ...(vouchedBy ? { vouchedBy } : {}),
  });
}
