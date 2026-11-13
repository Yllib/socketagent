import type * as http from "http";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// A reverse proxy on this computer connects from loopback on behalf of a
// client that is somewhere else, and says so with one of these.
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"] as const;

/**
 * Whether a socket's remote address is this computer. That alone does not
 * make a request local: a proxy on this computer connects from loopback too.
 * Use `isLoopbackRequest` for every rule that trusts "this computer".
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return LOOPBACK_ADDRESSES.has(address ?? "");
}

/**
 * Whether a request comes from this computer itself: a loopback address with
 * no proxy in front. Every rule that trusts "this computer" asks here, so a
 * tunnel or reverse proxy pointed at the port never counts as local.
 */
export function isLoopbackRequest(req: http.IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  return PROXY_HEADERS.every((header) => req.headers[header] === undefined);
}

/**
 * Whether the request target can be read as a URL. `//` cannot, and
 * `new URL` throws on it, so both listeners refuse such a request first.
 */
export function hasReadableTarget(req: http.IncomingMessage): boolean {
  return URL.canParse(req.url || "/", "http://localhost");
}

/**
 * Whether a request names an `Origin`, which only a web page's script does.
 * The app, the scripts and the CLI never send one, so the listener refuses
 * every upgrade and HTTP request that has it.
 */
export function hasOriginHeader(req: http.IncomingMessage): boolean {
  return req.headers.origin !== undefined;
}
