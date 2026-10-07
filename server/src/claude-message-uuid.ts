import * as crypto from "crypto";

/**
 * The uuid a Claude transcript stores for a delivery ID. UUIDs pass through.
 * Other IDs, such as the app's numeric prompt IDs and descriptive delegated
 * report IDs, map to a deterministic UUIDv8, since the SDK rejects anything
 * that is not a UUID.
 */
export function claudeMessageUuid(value: string): `${string}-${string}-${string}-${string}-${string}` {
  const isUuid = (candidate: string): candidate is `${string}-${string}-${string}-${string}-${string}` =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate);
  if (isUuid(value)) return value;
  const hash = crypto.createHash("sha256").update(`socketagent:claude-message:${value}`).digest("hex");
  const variant = ((parseInt(hash[16], 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
