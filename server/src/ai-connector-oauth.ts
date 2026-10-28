import * as crypto from "crypto";
import { z } from "zod";
import { deviceFingerprint } from "./device-registry";
import { errorMessage } from "./value-guards";
import {
  AiConnectorGrant,
  AiConnectorStore,
  IssuedTokens,
  TokenEndpointAuthMethod,
  hashToken,
  randomToken,
  tokenEndpointAuthMethods,
} from "./ai-connector-store";
import { ClientMetadataDocument, fetchClientMetadata, isClientMetadataUrl } from "./ai-connector-cimd";

/**
 * The OAuth 2.1 authorization server and resource server behind the AI
 * connector, as the MCP authorization spec (2025-11-25) asks for: protected
 * resource metadata, authorization server metadata, dynamic client
 * registration, client ID metadata documents, PKCE (S256 only), resource
 * indicators, rotating refresh tokens and short-lived access tokens.
 *
 * There is no password. The authorize page waits while the user's phone
 * shows a card naming the client; approving it on the phone issues the code.
 */

export const SIGN_IN_TTL_MS = 10 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
/** Sign-ins that can wait on the phone at once. More get temporarily_unavailable. */
export const MAX_PENDING_SIGN_INS = 3;
export const CLIENT_METADATA_CACHE_MS = 60 * 60 * 1000;
export const MCP_PATH = "/mcp";

export type SignInStatus = "pending" | "approved" | "denied" | "expired";

export interface PendingSignIn {
  requestId: string;
  /** Becomes the client's device registry key once approved. */
  publicKey: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  scope?: string;
  codeChallenge: string;
  resource?: string;
  /** Six digits shown in the browser and on the phone. */
  code: string;
  createdAt: number;
  expiresAt: number;
  status: SignInStatus;
  authCode?: string;
  /** The browser was already sent to the client; later refreshes get a plain page. */
  redirected?: boolean;
}

interface AuthorizationCode {
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope?: string;
  expiresAt: number;
}

export interface AiConnectorOAuthHost {
  store: AiConnectorStore;
  serverName(): string;
  now?(): number;
  /** Shows the sign-in on every phone, like a device waiting for approval. */
  signInPending(signIn: PendingSignIn): void;
  /** The sign-in was decided or expired; phones drop the notice. */
  signInSettled(signIn: PendingSignIn): void;
  /** Enrolls the client's key and creates its activity session. */
  grantAccess(signIn: PendingSignIn): { sessionId: string };
  /** An approved sign-in the client never redeemed: the grant is gone, so its device entry should go too. */
  grantAbandoned(grant: AiConnectorGrant): void;
  /** Replaceable for tests; the default fetches the document over HTTPS. */
  fetchClientMetadata?(clientId: string): Promise<ClientMetadataDocument>;
}

/** An OAuth error for the token or registration endpoint. */
export class OAuthError extends Error {
  constructor(readonly code: string, description: string, readonly status = 400) {
    super(description);
  }
}

/** An authorize request the browser should carry back to the client as an error. */
export class AuthorizeRedirectError extends Error {
  constructor(readonly redirectUri: string, readonly code: string, description: string, readonly state?: string) {
    super(description);
  }
}

const registrationSchema = z.object({
  redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(20),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** Exact match, except that loopback redirects match on any port (RFC 8252 7.3). */
export function redirectUriAllowed(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  let wanted: URL;
  try {
    wanted = new URL(candidate);
  } catch {
    return false;
  }
  if (wanted.protocol !== "http:" || !isLoopbackUrl(wanted)) return false;
  return registered.some((entry) => {
    try {
      const known = new URL(entry);
      return known.protocol === "http:" && isLoopbackUrl(known)
        && known.hostname.toLowerCase() === wanted.hostname.toLowerCase()
        && known.pathname === wanted.pathname;
    } catch {
      return false;
    }
  });
}

/** Redirect URIs must be HTTPS or a loopback HTTP address. */
export function redirectUriRegistrable(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackUrl(url));
  } catch {
    return false;
  }
}

/** A clean client name for cards: printable, trimmed, bounded. */
export function cleanClientName(value: string | undefined, fallback = "AI client"): string {
  const cleaned = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return cleaned || fallback;
}

/** Normalizes the public URL to an origin: https, no path, no trailing slash. http is allowed on loopback for local tests. */
export function normalizePublicUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("The public URL must be a full address such as https://agent.example.com");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackUrl(url))) {
    throw new Error("The public URL must use https");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
    throw new Error("The public URL must be just the host, with no path");
  }
  return url.origin;
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashesMatch(secret: string, hash: string): boolean {
  const a = Buffer.from(hashToken(secret));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface TokenRequest {
  grant_type?: string;
  code?: string;
  code_verifier?: string;
  redirect_uri?: string;
  refresh_token?: string;
  resource?: string;
  client_id?: string;
  client_secret?: string;
  /** From an Authorization: Basic header, when the client used client_secret_basic. */
  basic?: { clientId: string; clientSecret: string };
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

export class AiConnectorOAuth {
  private signIns = new Map<string, PendingSignIn>();
  private codes = new Map<string, AuthorizationCode>();
  private metadataCache = new Map<string, { document: ClientMetadataDocument; fetchedAt: number }>();

  constructor(private readonly host: AiConnectorOAuthHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  get store(): AiConnectorStore {
    return this.host.store;
  }

  /** The origin the tunnel exposes. Empty until the user sets it. */
  get publicUrl(): string {
    return this.store.settings.publicUrl;
  }

  /** RFC 8707 resource identifier: the MCP endpoint itself. */
  get resourceUrl(): string {
    return `${this.publicUrl}${MCP_PATH}`;
  }

  get resourceMetadataUrl(): string {
    return `${this.publicUrl}/.well-known/oauth-protected-resource${MCP_PATH}`;
  }

  // ── Metadata ──

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resourceUrl,
      authorization_servers: [this.publicUrl],
      bearer_methods_supported: ["header"],
      resource_name: `SocketAgent on ${this.host.serverName()}`,
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    const base = this.publicUrl;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [...tokenEndpointAuthMethods],
      revocation_endpoint_auth_methods_supported: [...tokenEndpointAuthMethods],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // ── Dynamic client registration (RFC 7591) ──

  register(body: unknown): Record<string, unknown> {
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) throw new OAuthError("invalid_client_metadata", "redirect_uris is required");
    const { redirect_uris: redirectUris } = parsed.data;
    for (const uri of redirectUris) {
      if (!redirectUriRegistrable(uri)) {
        throw new OAuthError("invalid_redirect_uri", `Redirect URIs must use https or a loopback address: ${uri}`);
      }
    }
    const requestedMethod = parsed.data.token_endpoint_auth_method ?? "client_secret_basic";
    const method = tokenEndpointAuthMethods.find((known) => known === requestedMethod);
    if (!method) throw new OAuthError("invalid_client_metadata", `Unsupported token_endpoint_auth_method ${requestedMethod}`);
    const grantTypes = parsed.data.grant_types ?? ["authorization_code"];
    if (!grantTypes.includes("authorization_code") || grantTypes.some((type) => type !== "authorization_code" && type !== "refresh_token")) {
      throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
    }
    if (parsed.data.response_types && parsed.data.response_types.some((type) => type !== "code")) {
      throw new OAuthError("invalid_client_metadata", "Only the code response type is supported");
    }
    const clientId = randomToken(16);
    const clientSecret = method === "none" ? undefined : randomToken();
    const client = this.store.saveClient({
      clientId,
      clientName: cleanClientName(parsed.data.client_name),
      redirectUris,
      tokenEndpointAuthMethod: method,
      ...(clientSecret ? { clientSecretHash: hashToken(clientSecret) } : {}),
      via: "dcr",
    });
    return {
      client_id: client.clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: grantTypes.includes("refresh_token") ? grantTypes : [...grantTypes, "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    };
  }

  // ── Client lookup, including client ID metadata documents ──

  private async resolveClient(clientId: string): Promise<{ clientName: string; redirectUris: string[]; tokenEndpointAuthMethod: TokenEndpointAuthMethod; clientSecretHash?: string }> {
    const stored = this.store.getClient(clientId);
    if (stored) return stored;
    if (!isClientMetadataUrl(clientId)) throw new OAuthError("invalid_client", "Unknown client_id", 401);
    const cached = this.metadataCache.get(clientId);
    let document = cached && this.now() - cached.fetchedAt < CLIENT_METADATA_CACHE_MS ? cached.document : undefined;
    if (!document) {
      try {
        document = await (this.host.fetchClientMetadata ?? fetchClientMetadata)(clientId);
      } catch (err: unknown) {
        throw new OAuthError("invalid_client", `Could not read the client's metadata document: ${errorMessage(err)}`, 401);
      }
      this.metadataCache.set(clientId, { document, fetchedAt: this.now() });
    }
    const methods = document.token_endpoint_auth_methods_supported
      ?? (document.token_endpoint_auth_method ? [document.token_endpoint_auth_method] : ["none"]);
    if (!methods.includes("none")) {
      throw new OAuthError("invalid_client", "A client identified by a metadata document must support the none token auth method", 401);
    }
    for (const uri of document.redirect_uris) {
      if (!redirectUriRegistrable(uri)) throw new OAuthError("invalid_client", `Client metadata lists an unsupported redirect URI: ${uri}`, 401);
    }
    const name = cleanClientName(document.client_name, new URL(clientId).hostname);
    const client = this.store.saveClient({
      clientId,
      clientName: name,
      redirectUris: document.redirect_uris,
      tokenEndpointAuthMethod: "none",
      via: "cimd",
    });
    return client;
  }

  // ── Authorization endpoint ──

  /**
   * Validates an authorize request and starts a sign-in. Errors the client
   * must hear about come back as AuthorizeRedirectError; ones that cannot be
   * trusted to a redirect URI come back as OAuthError for the error page.
   */
  async authorize(query: URLSearchParams): Promise<PendingSignIn> {
    this.sweep();
    const clientId = query.get("client_id")?.trim() || "";
    if (!clientId) throw new OAuthError("invalid_request", "client_id is required");
    const client = await this.resolveClient(clientId);
    let redirectUri = query.get("redirect_uri") || "";
    if (!redirectUri) {
      if (client.redirectUris.length !== 1) throw new OAuthError("invalid_request", "redirect_uri is required");
      redirectUri = client.redirectUris[0];
    } else if (!redirectUriAllowed(client.redirectUris, redirectUri)) {
      throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
    }
    const state = query.get("state") ?? undefined;
    const fail = (code: string, description: string) => new AuthorizeRedirectError(redirectUri, code, description, state);
    if (query.get("response_type") !== "code") throw fail("unsupported_response_type", "response_type must be code");
    const codeChallenge = query.get("code_challenge") || "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw fail("invalid_request", "A PKCE S256 code_challenge is required");
    if ((query.get("code_challenge_method") || "") !== "S256") throw fail("invalid_request", "code_challenge_method must be S256");
    const resource = query.get("resource") ?? undefined;
    if (resource !== undefined && !this.resourceAccepted(resource)) {
      throw fail("invalid_target", `resource must be ${this.resourceUrl}`);
    }
    const scope = query.get("scope")?.trim() || undefined;
    const open = Array.from(this.signIns.values()).filter((entry) => entry.status === "pending");
    if (open.length >= MAX_PENDING_SIGN_INS) {
      throw fail("temporarily_unavailable", "Too many sign-ins are waiting for approval. Try again in a few minutes.");
    }
    const publicKey = crypto.randomBytes(32).toString("base64");
    const now = this.now();
    const signIn: PendingSignIn = {
      requestId: randomToken(24),
      publicKey,
      clientId,
      clientName: client.clientName,
      redirectUri,
      ...(state !== undefined ? { state } : {}),
      ...(scope ? { scope } : {}),
      codeChallenge,
      ...(resource !== undefined ? { resource } : {}),
      code: deviceFingerprint(publicKey),
      createdAt: now,
      expiresAt: now + SIGN_IN_TTL_MS,
      status: "pending",
    };
    this.signIns.set(signIn.requestId, signIn);
    this.store.touchClient(clientId);
    this.host.signInPending(signIn);
    return { ...signIn };
  }

  /** The resource parameter must name this MCP server, with or without the /mcp path. */
  resourceAccepted(resource: string): boolean {
    const normalized = resource.replace(/\/$/, "");
    return normalized === this.resourceUrl || normalized === this.publicUrl;
  }

  signIn(requestId: string): PendingSignIn | undefined {
    this.sweep();
    const entry = this.signIns.get(requestId);
    return entry ? { ...entry } : undefined;
  }

  signInForKey(publicKey: string): PendingSignIn | undefined {
    this.sweep();
    const entry = Array.from(this.signIns.values()).find((candidate) => candidate.publicKey === publicKey);
    return entry ? { ...entry } : undefined;
  }

  /** Sign-ins still waiting on the phone, for device lists and reconnecting devices. */
  pendingSignIns(): PendingSignIn[] {
    this.sweep();
    return Array.from(this.signIns.values()).filter((entry) => entry.status === "pending").map((entry) => ({ ...entry }));
  }

  /** The phone allowed the sign-in named by its key. Returns false when none was waiting. */
  approveSignIn(publicKey: string): boolean {
    this.sweep();
    const signIn = Array.from(this.signIns.values()).find((entry) => entry.publicKey === publicKey && entry.status === "pending");
    if (!signIn) return false;
    const { sessionId } = this.host.grantAccess(signIn);
    const grant = this.store.createGrant({
      clientId: signIn.clientId,
      clientName: signIn.clientName,
      publicKey: signIn.publicKey,
      sessionId,
    });
    const authCode = randomToken();
    this.codes.set(authCode, {
      grantId: grant.grantId,
      clientId: signIn.clientId,
      redirectUri: signIn.redirectUri,
      codeChallenge: signIn.codeChallenge,
      ...(signIn.resource !== undefined ? { resource: signIn.resource } : {}),
      ...(signIn.scope ? { scope: signIn.scope } : {}),
      expiresAt: this.now() + AUTH_CODE_TTL_MS,
    });
    signIn.status = "approved";
    signIn.authCode = authCode;
    this.host.signInSettled(signIn);
    return true;
  }

  denySignIn(publicKey: string): boolean {
    this.sweep();
    const signIn = Array.from(this.signIns.values()).find((entry) => entry.publicKey === publicKey && entry.status === "pending");
    if (!signIn) return false;
    signIn.status = "denied";
    this.host.signInSettled(signIn);
    return true;
  }

  /**
   * Where the browser goes next for a decided sign-in, or undefined while it
   * waits. The code is handed over once; later visits get the error form.
   */
  redirectFor(requestId: string): string | undefined {
    this.sweep();
    const signIn = this.signIns.get(requestId);
    if (!signIn || signIn.status === "pending") return undefined;
    const url = new URL(signIn.redirectUri);
    if (signIn.state !== undefined) url.searchParams.set("state", signIn.state);
    url.searchParams.set("iss", this.publicUrl);
    if (signIn.status === "approved" && signIn.authCode && !signIn.redirected) {
      url.searchParams.set("code", signIn.authCode);
      signIn.redirected = true;
    } else {
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", signIn.status === "expired"
        ? "The sign-in was not approved in time"
        : signIn.status === "denied" ? "The user declined the sign-in" : "The sign-in was already completed");
    }
    return url.toString();
  }

  /** Builds the error redirect for an AuthorizeRedirectError. */
  errorRedirect(error: AuthorizeRedirectError): string {
    const url = new URL(error.redirectUri);
    url.searchParams.set("error", error.code);
    url.searchParams.set("error_description", error.message);
    if (error.state !== undefined) url.searchParams.set("state", error.state);
    url.searchParams.set("iss", this.publicUrl);
    return url.toString();
  }

  // ── Token endpoint ──

  private authenticateClient(request: TokenRequest): { clientId: string; method: TokenEndpointAuthMethod } {
    const clientId = request.basic?.clientId || request.client_id?.trim() || "";
    if (!clientId) throw new OAuthError("invalid_client", "client_id is required", 401);
    const client = this.store.getClient(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
    const secret = request.basic?.clientSecret ?? request.client_secret;
    if (client.tokenEndpointAuthMethod === "none") {
      return { clientId, method: "none" };
    }
    if (!secret || !client.clientSecretHash || !hashesMatch(secret, client.clientSecretHash)) {
      throw new OAuthError("invalid_client", "Client authentication failed", 401);
    }
    return { clientId, method: client.tokenEndpointAuthMethod };
  }

  token(request: TokenRequest): TokenResponse {
    this.sweep();
    const { clientId } = this.authenticateClient(request);
    if (request.grant_type === "authorization_code") {
      const code = request.code || "";
      const entry = this.codes.get(code);
      if (entry) this.codes.delete(code);
      if (!entry) throw new OAuthError("invalid_grant", "The authorization code is unknown or expired");
      // A code is handed over once. Whatever goes wrong below burns it, and
      // a grant that will never be redeemed is dropped with it.
      try {
        if (entry.expiresAt <= this.now()) throw new OAuthError("invalid_grant", "The authorization code is unknown or expired");
        if (entry.clientId !== clientId) throw new OAuthError("invalid_grant", "The code belongs to another client");
        if (request.redirect_uri !== undefined && request.redirect_uri !== entry.redirectUri) {
          throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
        }
        if (!request.code_verifier || !pkceMatches(request.code_verifier, entry.codeChallenge)) {
          throw new OAuthError("invalid_grant", "code_verifier does not match the code_challenge");
        }
        if (request.resource !== undefined && !this.resourceAccepted(request.resource)) {
          throw new OAuthError("invalid_target", `resource must be ${this.resourceUrl}`);
        }
        if (!this.store.getGrant(entry.grantId)) throw new OAuthError("invalid_grant", "The grant was revoked");
      } catch (err: unknown) {
        this.abandon(entry.grantId);
        throw err;
      }
      return this.tokenResponse(this.store.issueTokens(entry.grantId), entry.scope);
    }
    if (request.grant_type === "refresh_token") {
      const token = request.refresh_token || "";
      if (!token) throw new OAuthError("invalid_request", "refresh_token is required");
      if (request.resource !== undefined && !this.resourceAccepted(request.resource)) {
        throw new OAuthError("invalid_target", `resource must be ${this.resourceUrl}`);
      }
      const rotated = this.store.rotateRefreshToken(token);
      if (!rotated.ok) throw new OAuthError("invalid_grant", rotated.error);
      if (rotated.grant.clientId !== clientId) throw new OAuthError("invalid_grant", "The refresh token belongs to another client");
      return this.tokenResponse(rotated.tokens);
    }
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  private tokenResponse(tokens: IssuedTokens, scope?: string): TokenResponse {
    return {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      ...(scope ? { scope } : {}),
    };
  }

  /** RFC 7009. The client must authenticate; unknown tokens are ignored. */
  revoke(request: TokenRequest & { token?: string }): void {
    this.authenticateClient(request);
    if (request.token) this.store.revokeToken(request.token);
  }

  // ── Resource server ──

  /** The grant behind a bearer header, or undefined when it is missing, malformed, expired or revoked. */
  authenticateBearer(authorization: string | undefined): AiConnectorGrant | undefined {
    const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/i.exec(authorization || "");
    if (!match) return undefined;
    return this.store.grantForAccessToken(match[1]);
  }

  /** The user removed the client in the app: its tokens and any open sign-in go. */
  revokeKey(publicKey: string): void {
    this.store.revokeGrantForKey(publicKey);
    this.denySignIn(publicKey);
  }

  /** The code for this grant will never be redeemed; the grant goes unless tokens were already issued. */
  private abandon(grantId: string): void {
    const grant = this.store.revokeUnredeemedGrant(grantId);
    if (grant) this.host.grantAbandoned(grant);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, signIn] of this.signIns) {
      if (signIn.status === "pending" && signIn.expiresAt <= now) {
        signIn.status = "expired";
        this.host.signInSettled(signIn);
      }
      // Decided sign-ins linger so the browser can still be redirected, then go.
      if (signIn.status !== "pending" && signIn.expiresAt + SIGN_IN_TTL_MS <= now) this.signIns.delete(id);
    }
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt > now) continue;
      this.codes.delete(code);
      this.abandon(entry.grantId);
    }
  }

  /** Expires sign-ins on a timer so phones hear about it without a request. */
  startSweeping(): () => void {
    const timer = setInterval(() => this.sweep(), 30_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
