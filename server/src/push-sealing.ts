import * as crypto from "crypto";
import * as nacl from "tweetnacl";
import type { DeviceEntry, PairingSecret } from "./device-registry";
import { derivePushKey, secretTag } from "./transport-v2";

/**
 * Sealed push notifications (wire spec section 11). The computer seals one
 * push for each pairing secret a recorded phone may still hold, and the relay
 * and Firebase carry text they cannot read. push-notifications.ts sends what
 * these functions build.
 */

/** A sealed push is kept inside this so the message fits FCM's 4 KB. */
export const MAX_SEALED_PUSH_BYTES = 3000;
/** The current secret and this many older ones get an entry each. */
const MAX_OLDER_SECRETS = 2;
/** Ends a body that was cut to fit. */
const CUT_MARK = "...";

export interface PushNotificationPayload {
  title: string;
  body?: string;
  sessionId?: string;
  status?: string;
  kind?: string;
  data?: Record<string, string | number | boolean | null | undefined>;
  showNotification?: boolean;
}

/** What goes to the relay beside `type` and `id` in a `relay_push` frame. */
export interface RelayPushRequest {
  sealed: string;
  /** Fills in for phones that registered with the relay without a server ID. */
  serverId?: string;
  /** Plaintext for phones still on the old path. Left out when none is recorded. */
  legacy?: Record<string, unknown>;
}

/** The part of the device registry that push sealing reads. */
export interface PushSecretSource {
  readonly readable: boolean;
  currentSecret(): PairingSecret;
  previousSecrets(): PairingSecret[];
  list(): DeviceEntry[];
}

function customData(payload: PushNotificationPayload): Record<string, string> {
  return Object.fromEntries(Object.entries(payload.data ?? {}).map(([key, value]) => [key, value == null ? "" : String(value)]));
}

/**
 * The string map a phone gets once it opens a sealed push: what the relay's
 * `buildPushData` builds for the old path, without `serverId`. The phone adds
 * that itself.
 */
export function pushDataMap(payload: PushNotificationPayload): Record<string, string> {
  return {
    ...customData(payload),
    title: payload.title,
    body: payload.body ?? "",
    sessionId: payload.sessionId ?? "",
    status: payload.status || "manual",
    kind: payload.kind ?? "",
    showNotification: payload.showNotification === false ? "false" : "true",
  };
}

/** Today's plaintext data map for a phone that registered on the old path. */
export function plainPushData(payload: PushNotificationPayload, serverId: string): Record<string, string> {
  return {
    title: payload.title,
    body: payload.body ?? "",
    sessionId: payload.sessionId ?? "",
    serverId,
    status: payload.status || "manual",
    kind: payload.kind ?? "",
    ...customData(payload),
  };
}

/** The `legacy` part of a `relay_push`: the fields `/api/push/send` took. */
export function legacyPushFields(payload: PushNotificationPayload): Record<string, unknown> {
  return {
    title: payload.title,
    body: payload.body ?? "",
    sessionId: payload.sessionId ?? "",
    status: payload.status || "manual",
    kind: payload.kind ?? "",
    showNotification: payload.showNotification !== false,
    data: payload.data ?? {},
  };
}

/**
 * The pairing secrets a push is sealed for, newest first: the current one,
 * then up to two older ones that are still the newest secret some recorded
 * device was handed. Empty when the state file cannot be read.
 */
export function pushSealingSecrets(source: PushSecretSource): Buffer[] {
  if (!source.readable) return [];
  const inUse = new Set(source.list().filter((entry) => entry.kind === "device").map((entry) => entry.secretId));
  const older = source.previousSecrets().filter((secret) => inUse.has(secret.id)).slice(0, MAX_OLDER_SECRETS);
  return [source.currentSecret(), ...older].map((secret) => Buffer.from(secret.secret, "base64"));
}

/** How long `sealed` is for a plaintext of [plaintextBytes] sealed [entries] times. */
function sealedLength(plaintextBytes: number, entries: number): number {
  const boxed = nacl.secretbox.nonceLength + nacl.secretbox.overheadLength + plaintextBytes;
  const entry = 8 + 1 + Math.ceil(boxed / 3) * 4;
  return entries * entry + (entries - 1);
}

/**
 * Seals a push once for each secret, as spec 11.1 lays it out. A body that
 * would push the result past 3,000 bytes is cut until it fits. Returns null
 * when there is no secret, or when the push is too long even with no body.
 */
export function sealPush(payload: PushNotificationPayload, secrets: readonly Uint8Array[]): string | null {
  if (secrets.length === 0) return null;
  const fits = (map: Record<string, string>) => sealedLength(Buffer.byteLength(JSON.stringify(map)), secrets.length) <= MAX_SEALED_PUSH_BYTES;
  let map = pushDataMap(payload);
  if (!fits(map)) {
    const letters = Array.from(map.body);
    const cutTo = (count: number) => ({ ...map, body: count > 0 ? letters.slice(0, count).join("") + CUT_MARK : "" });
    if (!fits(cutTo(0))) return null;
    // The longest cut that fits: every shorter one fits too.
    let kept = 0;
    for (let low = 1, high = letters.length - 1; low <= high;) {
      const middle = Math.floor((low + high) / 2);
      if (fits(cutTo(middle))) {
        kept = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    map = cutTo(kept);
  }
  const plaintext = Buffer.from(JSON.stringify(map));
  return secrets.map((secret) => {
    const nonce = crypto.randomBytes(nacl.secretbox.nonceLength);
    const box = nacl.secretbox(plaintext, nonce, derivePushKey(secret));
    return `${secretTag(secret)}.${Buffer.concat([nonce, box]).toString("base64")}`;
  }).join(",");
}
