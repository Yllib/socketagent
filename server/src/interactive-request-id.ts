import * as crypto from "crypto";

/** Interactive request IDs become durable transcript identities. */
export function createInteractiveRequestId(prefix: string): string {
  const safePrefix = prefix.trim().replace(/[^A-Za-z0-9_-]+/g, "_") || "request";
  return `${safePrefix}_${crypto.randomUUID()}`;
}
