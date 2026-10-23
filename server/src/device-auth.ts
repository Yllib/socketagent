import * as crypto from "crypto";
import { DeviceRegistry, DevicePlatform, deviceFingerprint } from "./device-registry";

/** Relay lanes. Device keys use control and bulk; computer keys use link only. */
export type RelayLane = "control" | "bulk" | "link";
export type PeerAdmission = "approved" | "pending" | "refused";

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

export type DeviceAuthOutcome =
  | { ok: true; enrolled: boolean }
  | {
      ok: false;
      reason: DeviceAuthReason;
      /** Fingerprint shown on both devices while approval is pending. */
      code?: string;
      /** The peer should be dropped after this reply. */
      close?: boolean;
      /** Enrolled devices should be told about this pending key. */
      notify?: { publicKey: string; name: string; platform: DevicePlatform; code: string };
    };

const WRONG_TOKEN_LIMIT = 5;
const WRONG_TOKEN_WINDOW_MS = 10 * 60 * 1000;

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
 * Decides what a relay peer may do based on its X25519 key. The relay only
 * forwards ciphertext, so the token check and every enrollment happen here.
 */
export class DeviceAuthGate {
  private wrongTokens = new Map<string, number[]>();

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly currentToken: () => string,
  ) {}

  /** Admission for a key that just finished a key exchange on `lane`. */
  authorize(publicKey: string, lane: RelayLane): PeerAdmission {
    const entry = this.registry.get(publicKey);
    if (lane === "link") {
      if (entry?.kind !== "computer") return "refused";
      this.registry.touch(publicKey);
      return "approved";
    }
    if (entry?.kind === "computer") return "refused";
    if (entry) {
      this.registry.touch(publicKey);
      return "approved";
    }
    if (this.registry.mode === "learning" && !this.registry.isRevoked(publicKey)) {
      this.registry.enroll({ publicKey, kind: "device", name: "", platform: "android", via: "migration" });
      return "approved";
    }
    return "pending";
  }

  /** Handles an encrypted device_auth from a peer on `lane`. */
  deviceAuth(publicKey: string, lane: RelayLane, request: DeviceAuthRequest): DeviceAuthOutcome {
    if (lane === "link") return { ok: false, reason: "wrong_lane", close: true };
    const entry = this.registry.get(publicKey);
    if (entry?.kind === "computer") return { ok: false, reason: "wrong_lane", close: true };
    const name = (request.name || "").trim().slice(0, 80);
    const platform = request.platform;
    if (entry) {
      this.registry.touch(publicKey, { name: name || undefined, platform });
      return { ok: true, enrolled: false };
    }
    const code = deviceFingerprint(publicKey);
    const notify = { publicKey, name: name || "Unknown device", platform: platform || "android", code };
    if (typeof request.token === "string" && request.token) {
      if (!this.registry.isRevoked(publicKey) && constantTimeEqual(request.token, this.currentToken())) {
        this.registry.enroll({ publicKey, kind: "device", name, platform: platform || "android", via: "token" });
        this.wrongTokens.delete(publicKey);
        return { ok: true, enrolled: true };
      }
      if (this.noteWrongToken(publicKey)) {
        return { ok: false, reason: "too_many_attempts", close: true };
      }
    }
    return { ok: false, reason: "approval_required", code, notify };
  }

  /**
   * Handles a token-less direct_auth on a direct socket, where the key
   * exchange already proved `publicKey`. From this computer it works like
   * device_auth over the relay, so another Windows account's app can ask for
   * approval. From the network only an enrolled device gets in, which gives
   * phones approved over the relay their LAN route without the token and
   * lets nobody there raise approval prompts.
   */
  directAuth(publicKey: string, request: DeviceAuthRequest, fromThisComputer: boolean): DeviceAuthOutcome {
    if (!fromThisComputer && this.registry.get(publicKey)?.kind !== "device") {
      return { ok: false, reason: "not_approved", close: true };
    }
    return this.deviceAuth(publicKey, "control", { name: request.name, platform: request.platform });
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
