import * as http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AiConnectorOAuth, AuthorizeRedirectError, MCP_PATH, OAuthError, PendingSignIn, TokenRequest } from "./ai-connector-oauth";
import { AiConnectorToolHost, createAiConnectorMcpServer } from "./ai-connector-mcp";
import { errorMessage, isRecord } from "./value-guards";

/**
 * The connector's own HTTP listener. It binds loopback only, serves nothing
 * but the MCP endpoint and the OAuth routes, and is what the user's tunnel
 * points at. The main server port never serves these routes, so a tunnel
 * aimed at the wrong port finds no connector and the connector port exposes
 * nothing else.
 */

export const MAX_BODY_BYTES = 64 * 1024;

/** Requests per minute for each route group. Tunnels hide client addresses, so limits are global. */
export const RATE_LIMITS: Record<RateLimitedRoute, number> = {
  register: 10,
  authorize: 20,
  wait: 300,
  token: 60,
  revoke: 60,
  metadata: 300,
};
export type RateLimitedRoute = "register" | "authorize" | "wait" | "token" | "revoke" | "metadata";

class FixedWindowLimiter {
  private counts = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** True when the call is allowed. */
  take(key: string, limit: number): boolean {
    const now = this.now();
    const entry = this.counts.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.counts.set(key, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

function page(title: string, body: string, refreshSeconds?: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${escapeHtml(title)}</title>
<style>
html,body{margin:0;background:#000;color:#fff;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:34rem;margin:0 auto;padding:3rem 1.5rem}
h1{font-size:1.25rem;font-weight:600;margin:0 0 1rem}
p{margin:0 0 .75rem}
.muted{color:#9a9a9a}
.code{font:700 2.25rem/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.15em;margin:1rem 0}
</style></head><body><main>${body}</main></body></html>`;
}

function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export interface AiConnectorHttpHost extends AiConnectorToolHost {
  oauth: AiConnectorOAuth;
  now?(): number;
}

export class AiConnectorHttp {
  private server: http.Server | undefined;
  private readonly limiter: FixedWindowLimiter;

  constructor(private readonly host: AiConnectorHttpHost) {
    this.limiter = new FixedWindowLimiter(60_000, host.now);
  }

  get listening(): boolean {
    return this.server?.listening === true;
  }

  get port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }

  /** Binds loopback only. Rejects when the port is taken. */
  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res).catch((err: unknown) => {
          console.error(`[AI connector] ${req.method} ${req.url} failed: ${errorMessage(err)}`);
          if (!res.headersSent) this.json(res, 500, { error: "server_error", error_description: "The connector hit an internal error" });
          else res.end();
        });
      });
      // Long tool calls hold the MCP response open; the SSE keep-alive keeps it alive.
      server.requestTimeout = 0;
      server.headersTimeout = 60_000;
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private baseHeaders(): Record<string, string> {
    return {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
  }

  private json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { ...this.baseHeaders(), "Content-Type": "application/json", ...extra });
    res.end(JSON.stringify(body));
  }

  private html(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      ...this.baseHeaders(),
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Frame-Options": "DENY",
    });
    res.end(body);
  }

  private redirect(res: http.ServerResponse, location: string): void {
    res.writeHead(302, { ...this.baseHeaders(), Location: location });
    res.end();
  }

  private limited(res: http.ServerResponse, route: RateLimitedRoute, asHtml = false): boolean {
    if (this.limiter.take(route, RATE_LIMITS[route])) return false;
    if (asHtml) this.html(res, 429, page("Too many requests", "<h1>Too many requests</h1><p class=\"muted\">Try again in a minute.</p>"));
    else this.json(res, 429, { error: "temporarily_unavailable", error_description: "Too many requests. Try again in a minute." }, { "Retry-After": "60" });
    return true;
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    const input: AsyncIterable<unknown, unknown, unknown> = req;
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(typeof chunk === "string" ? chunk : "");
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new OAuthError("invalid_request", "Request body is too large", 413);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Token-style endpoints take form bodies; JSON is accepted too. */
  private async readTokenRequest(req: http.IncomingMessage): Promise<TokenRequest & { token?: string }> {
    const body = await this.readBody(req);
    const contentType = String(req.headers["content-type"] || "");
    const fields: Record<string, string> = {};
    if (contentType.includes("application/json")) {
      const parsed: unknown = body ? JSON.parse(body) : {};
      if (isRecord(parsed)) {
        for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") fields[key] = value;
      }
    } else {
      for (const [key, value] of new URLSearchParams(body)) fields[key] = value;
    }
    const request: TokenRequest & { token?: string } = {
      grant_type: fields.grant_type, code: fields.code, code_verifier: fields.code_verifier,
      redirect_uri: fields.redirect_uri, refresh_token: fields.refresh_token, resource: fields.resource,
      client_id: fields.client_id, client_secret: fields.client_secret, token: fields.token,
    };
    const authorization = String(req.headers.authorization || "");
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization);
    if (basic) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        request.basic = {
          clientId: decodeURIComponent(decoded.slice(0, separator)),
          clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
        };
      }
    }
    return request;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method || "GET";
    const oauth = this.host.oauth;
    try {
      if (route === "/" && method === "GET") {
        res.writeHead(200, { ...this.baseHeaders(), "Content-Type": "text/plain; charset=utf-8" });
        res.end(`SocketAgent AI connector on ${this.host.serverName()}.\nAdd ${oauth.resourceUrl} to your AI client as a remote MCP server.\n`);
        return;
      }
      if (route === MCP_PATH) {
        await this.handleMcp(req, res);
        return;
      }
      if (method === "GET" && (route === "/.well-known/oauth-protected-resource" || route === `/.well-known/oauth-protected-resource${MCP_PATH}`)) {
        if (this.limited(res, "metadata")) return;
        this.json(res, 200, oauth.protectedResourceMetadata());
        return;
      }
      if (method === "GET" && (route === "/.well-known/oauth-authorization-server" || route === "/.well-known/openid-configuration")) {
        if (this.limited(res, "metadata")) return;
        this.json(res, 200, oauth.authorizationServerMetadata());
        return;
      }
      if (route === "/oauth/register" && method === "POST") {
        if (this.limited(res, "register")) return;
        const body = await this.readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          throw new OAuthError("invalid_client_metadata", "The registration body must be JSON");
        }
        this.json(res, 201, oauth.register(parsed));
        return;
      }
      if (route === "/oauth/authorize" && method === "GET") {
        if (this.limited(res, "authorize", true)) return;
        let signIn: PendingSignIn;
        try {
          signIn = await oauth.authorize(url.searchParams);
        } catch (err: unknown) {
          if (err instanceof AuthorizeRedirectError) {
            this.redirect(res, oauth.errorRedirect(err));
            return;
          }
          if (err instanceof OAuthError) {
            this.html(res, err.status, page("Sign-in failed", `<h1>Sign-in failed</h1><p>${escapeHtml(err.message)}</p>`));
            return;
          }
          throw err;
        }
        this.redirect(res, `/oauth/authorize/wait?request=${encodeURIComponent(signIn.requestId)}`);
        return;
      }
      if (route === "/oauth/authorize/wait" && method === "GET") {
        if (this.limited(res, "wait", true)) return;
        const requestId = url.searchParams.get("request") || "";
        const signIn = oauth.signIn(requestId);
        if (!signIn) {
          this.html(res, 404, page("Sign-in not found", "<h1>Sign-in not found</h1><p class=\"muted\">Start again from your AI client.</p>"));
          return;
        }
        if (signIn.status === "pending") {
          this.html(res, 200, this.waitingPage(signIn));
          return;
        }
        if (signIn.redirected) {
          this.html(res, 200, page("Signed in", "<h1>Signed in</h1><p class=\"muted\">You can close this tab.</p>"));
          return;
        }
        const location = oauth.redirectFor(requestId);
        if (location) this.redirect(res, location);
        else this.html(res, 200, this.waitingPage(signIn));
        return;
      }
      if (route === "/oauth/token" && method === "POST") {
        if (this.limited(res, "token")) return;
        const request = await this.readTokenRequest(req);
        this.json(res, 200, oauth.token(request));
        return;
      }
      if (route === "/oauth/revoke" && method === "POST") {
        if (this.limited(res, "revoke")) return;
        const request = await this.readTokenRequest(req);
        oauth.revoke(request);
        this.json(res, 200, {});
        return;
      }
      this.json(res, 404, { error: "not_found", error_description: "No such route on the SocketAgent AI connector" });
    } catch (err: unknown) {
      if (err instanceof OAuthError) {
        const extra: Record<string, string> = err.status === 401 ? { "WWW-Authenticate": "Basic realm=\"SocketAgent AI connector\"" } : {};
        this.json(res, err.status, { error: err.code, error_description: err.message }, extra);
        return;
      }
      throw err;
    }
  }

  private waitingPage(signIn: PendingSignIn): string {
    let redirectHost = signIn.redirectUri;
    try {
      redirectHost = new URL(signIn.redirectUri).host;
    } catch {
      // Shown as given.
    }
    return page(`Approve ${signIn.clientName}`, `
<h1>${escapeHtml(signIn.clientName)} wants to use your computers</h1>
<p>Approve this sign-in in the SocketAgent app on your phone. Allow it only if the phone shows this code.</p>
<div class="code">${formatCode(signIn.code)}</div>
<p class="muted">SocketAgent on ${escapeHtml(this.host.serverName())}. Afterwards you go back to ${escapeHtml(redirectHost)}.</p>
<p class="muted">This page checks every few seconds and expires in ${Math.max(1, Math.ceil((signIn.expiresAt - (this.host.now?.() ?? Date.now())) / 60_000))} min.</p>`, 3);
  }

  /** Bearer-protected MCP. Stateless: every request gets its own server and transport. */
  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const oauth = this.host.oauth;
    const grant = oauth.authenticateBearer(req.headers.authorization);
    if (!grant) {
      const hadToken = /^Bearer\s/i.test(String(req.headers.authorization || ""));
      const challenge = `Bearer resource_metadata="${oauth.resourceMetadataUrl}"${hadToken ? ', error="invalid_token", error_description="The access token is expired, revoked or unknown"' : ""}`;
      this.json(res, 401, { error: "invalid_token", error_description: "Sign in to the SocketAgent AI connector" }, { "WWW-Authenticate": challenge });
      return;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      this.json(res, 405, { error: "method_not_allowed" }, { Allow: "GET, POST, DELETE" });
      return;
    }
    const server = createAiConnectorMcpServer(grant, this.host);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
}
