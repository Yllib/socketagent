import * as crypto from "crypto";

/**
 * Whether two secrets are the same, in time that does not depend on where
 * they differ. Every compare of AUTH_TOKEN or another secret goes through
 * here, never through `===`.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    // Compare something of equal length so timing does not leak the length.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
