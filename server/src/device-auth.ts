import * as crypto from "crypto";
import { DeviceRegistry, DevicePlatform, deviceFingerprint } from "./device-registry";

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

const NOT_APPROVED: DeviceAuthOutcome = { ok: false, reason: "not_approved", close: true };

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    // Compare something of equal length so timing does not leak the length.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

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
  deviceAuth(publicKey: string, lane: RelayLane, request: DeviceAuthRequest): DeviceAuthOutcome {
    if (lane === "link") return { ok: false, reason: "wrong_lane", close: true };
    return this.admit(publicKey, request, "relay", false);
  }

  /**
   * Handles `direct_auth` on an `e2e=1` direct socket, where the key exchange
   * already proved `publicKey`. A recorded device needs no token. An unknown
   * key gets in with the right token, locked or not: released apps that only
   * ever connected this way were never recorded, and they must keep working
   * until the old path is shut down. A socket from this computer, which is
   * loopback with no proxy in front, may also send no token and raise an
   * approval prompt, for the old desktop app under another Windows account.
   */
  directAuth(publicKey: string, request: DeviceAuthRequest, fromThisComputer: boolean): DeviceAuthOutcome {
    return this.admit(publicKey, request, "direct", fromThisComputer);
  }

  private admit(publicKey: string, request: DeviceAuthRequest, path: "relay" | "direct", fromThisComputer: boolean): DeviceAuthOutcome {
    if (!this.registry.readable) {
      // Nothing can be recorded or looked up. This computer's own tools still
      // get in by the token, and nobody else does.
      const local = fromThisComputer && typeof request.token === "string" && constantTimeEqual(request.token, this.currentToken());
      return local ? { ok: true, enrolled: false } : NOT_APPROVED;
    }
    const reason = this.barred(publicKey, "control");
    if (reason) return { ok: false, reason, close: true };
    const name = (request.name || "").trim().slice(0, 80);
    const platform = request.platform;
    if (this.registry.get(publicKey)) {
      this.registry.touch(publicKey, { name: name || undefined, platform });
      return { ok: true, enrolled: false };
    }
    if (typeof request.token === "string" && request.token) {
      if (!constantTimeEqual(request.token, this.currentToken())) {
        return this.noteWrongToken(publicKey) ? { ok: false, reason: "too_many_attempts", close: true } : NOT_APPROVED;
      }
      // The lock holds on the relay, where every device that exists is
      // already on record. A direct token holder was never recorded by the
      // old build, so refusing it here would lock out a device paired today.
      if (this.registry.locked && path === "relay") return NOT_APPROVED;
      this.registry.enroll({ publicKey, kind: "device", name, platform: platform || "android", via: "token" });
      this.wrongTokens.delete(publicKey);
      return { ok: true, enrolled: true };
    }
    if (!fromThisComputer) return NOT_APPROVED;
    const code = deviceFingerprint(publicKey);
    return {
      ok: false, reason: "approval_required", code,
      notify: { publicKey, name: name || "Unknown device", platform: platform || "android", code },
    };
  }

  /** Returns true once the key has used up its wrong-token budget. */
  private noteWrongToken(publicKey: string): boolean {
    const now = Date.now();
    const recent = (this.wrongTokens.get(publicKey) || []).filter((at) => now - at < WRONG_TOKEN_WINDOW_MS);
    recent.push(now);
    this.wrongTokens.set(publicKey, recent);
    return recent.length > WRONG_TOKEN_LIMIT;
  }
}
