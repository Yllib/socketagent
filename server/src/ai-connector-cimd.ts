import * as dns from "dns";
import * as https from "https";
import * as net from "net";
import { z } from "zod";

/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document):
 * an AI client identifies itself with an HTTPS URL, and the authorization
 * server fetches the JSON there. Claude and ChatGPT both prefer this to
 * dynamic registration. The fetch follows a URL an unknown client supplied,
 * so it is pinned to public addresses, capped in size and never redirected.
 */

export const CLIENT_METADATA_MAX_BYTES = 64 * 1024;
export const CLIENT_METADATA_TIMEOUT_MS = 10_000;

const clientMetadataSchema = z.object({
  client_id: z.string().min(1),
  client_name: z.string().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().min(1)).min(1),
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  grant_types: z.array(z.string()).optional(),
});
export type ClientMetadataDocument = z.infer<typeof clientMetadataSchema>;

/** Whether `clientId` has the shape a metadata document URL must have. */
export function isClientMetadataUrl(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.pathname.length > 1 && !url.hash && !url.username && !url.password;
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice("::ffff:".length));
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

/** Resolves the host once and refuses private, loopback and link-local answers. */
async function publicAddressFor(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("Client metadata must be on a public host");
    return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Client metadata must be on a public host");
  }
  const { address, family } = await dns.promises.lookup(hostname);
  if (isPrivateAddress(address)) throw new Error("Client metadata must be on a public host");
  return { address, family: family === 6 ? 6 : 4 };
}

/**
 * Fetches and validates the document at `clientId`. The connection goes to
 * the address vetted here, so a DNS answer cannot change between the check
 * and the request.
 */
export async function fetchClientMetadata(clientId: string): Promise<ClientMetadataDocument> {
  if (!isClientMetadataUrl(clientId)) throw new Error("client_id is not an HTTPS metadata URL");
  const url = new URL(clientId);
  const pinned = await publicAddressFor(url.hostname);
  const body = await new Promise<string>((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "SocketAgent AI connector" },
      timeout: CLIENT_METADATA_TIMEOUT_MS,
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Client metadata returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > CLIENT_METADATA_MAX_BYTES) {
          request.destroy(new Error("Client metadata is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Client metadata fetch timed out")));
    request.on("error", reject);
    request.end();
  });
  const parsed: unknown = JSON.parse(body);
  const document = clientMetadataSchema.parse(parsed);
  if (document.client_id !== clientId) throw new Error("Client metadata client_id does not match its URL");
  return document;
}
