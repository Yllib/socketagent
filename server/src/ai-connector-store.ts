import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { errorMessage } from "./value-guards";

/**
 * What the AI connector keeps on disk: its settings, the OAuth clients that
 * registered, the grants the user approved on the phone, and the hashes of
 * the tokens issued for them. Token plaintext is never stored, so a copy of
 * this file cannot be used to reach the connector.
 */

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A refresh token reused this soon after rotation is treated as a lost response, not theft. */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000;
export const DEFAULT_AI_CONNECTOR_PORT = 8086;
/** Registered clients that never completed a sign-in are forgotten after this. */
export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

export const tokenEndpointAuthMethods = ["none", "client_secret_post", "client_secret_basic"] as const;
export type TokenEndpointAuthMethod = typeof tokenEndpointAuthMethods[number];

export interface AiConnectorSettings {
  enabled: boolean;
  /** HTTPS origin of the user's tunnel, without a path. Empty until set. */
  publicUrl: string;
  /** Loopback port the connector listener binds. */
  port: number;
}

export interface AiConnectorClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  /** SHA-256 hex of the secret issued to a confidential client. */
  clientSecretHash?: string;
  /** "dcr" registered itself; "cimd" is identified by its metadata URL. */
  via: "dcr" | "cimd";
  createdAt: string;
  lastUsedAt: string;
}

/** One approval on the phone: a client the user let in, with its own tokens. */
export interface AiConnectorGrant {
  grantId: string;
  clientId: string;
  clientName: string;
  /** The device registry key for this client; access and confirm live there. */
  publicKey: string;
  /** The session whose transcript logs this client's actions and shows its cards. */
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface AiConnectorTokenRecord {
  hash: string;
  kind: "access" | "refresh";
  grantId: string;
  issuedAt: number;
  expiresAt: number;
  /** A refresh token that was rotated away; reuse after the grace period revokes the grant. */
  supersededAt?: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const settingsSchema = z.object({
  enabled: z.boolean().default(false),
  publicUrl: z.string().default(""),
  port: z.number().int().min(1).max(65535).default(DEFAULT_AI_CONNECTOR_PORT),
});

const clientSchema = z.object({
  clientId: z.string().min(1),
  clientName: z.string(),
  redirectUris: z.array(z.string()),
  tokenEndpointAuthMethod: z.enum(tokenEndpointAuthMethods),
  clientSecretHash: z.string().optional(),
  via: z.enum(["dcr", "cimd"]),
  createdAt: z.string(),
  lastUsedAt: z.string(),
});

const grantSchema = z.object({
  grantId: z.string().min(1),
  clientId: z.string().min(1),
  clientName: z.string(),
  publicKey: z.string().min(1),
  sessionId: z.string().min(1),
  createdAt: z.string(),
  lastUsedAt: z.string(),
});

const tokenSchema = z.object({
  hash: z.string().min(1),
  kind: z.enum(["access", "refresh"]),
  grantId: z.string().min(1),
  issuedAt: z.number(),
  expiresAt: z.number(),
  supersededAt: z.number().optional(),
});

const fileSchema = z.object({
  version: z.literal(1),
  settings: settingsSchema.default({ enabled: false, publicUrl: "", port: DEFAULT_AI_CONNECTOR_PORT }),
  clients: z.array(clientSchema).default([]),
  grants: z.array(grantSchema).default([]),
  tokens: z.array(tokenSchema).default([]),
});
type AiConnectorFile = z.infer<typeof fileSchema>;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export class AiConnectorStore {
  private state: AiConnectorFile;

  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {
    this.state = this.read() ?? fileSchema.parse({ version: 1 });
  }

  private read(): AiConnectorFile | undefined {
    try {
      if (!fs.existsSync(this.filePath)) return undefined;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return fileSchema.parse(parsed);
    } catch (err: unknown) {
      console.error(`[AI connector] Could not read ${this.filePath}: ${errorMessage(err)}. Starting with no clients.`);
      return undefined;
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    try {
      if (process.platform !== "win32") fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  }

  // ── Settings ──

  get settings(): AiConnectorSettings {
    return { ...this.state.settings };
  }

  saveSettings(patch: Partial<AiConnectorSettings>): AiConnectorSettings {
    this.state.settings = { ...this.state.settings, ...patch };
    this.write();
    return this.settings;
  }

  // ── Clients ──

  getClient(clientId: string): AiConnectorClient | undefined {
    const client = this.state.clients.find((entry) => entry.clientId === clientId);
    return client ? { ...client, redirectUris: [...client.redirectUris] } : undefined;
  }

  saveClient(client: Omit<AiConnectorClient, "createdAt" | "lastUsedAt">): AiConnectorClient {
    const stamp = new Date(this.now()).toISOString();
    const existing = this.state.clients.find((entry) => entry.clientId === client.clientId);
    const next: AiConnectorClient = { ...client, createdAt: existing?.createdAt ?? stamp, lastUsedAt: stamp };
    if (existing) this.state.clients[this.state.clients.indexOf(existing)] = next;
    else this.state.clients.push(next);
    this.pruneClients();
    this.write();
    return { ...next };
  }

  touchClient(clientId: string): void {
    const client = this.state.clients.find((entry) => entry.clientId === clientId);
    if (!client) return;
    client.lastUsedAt = new Date(this.now()).toISOString();
    this.write();
  }

  /** Clients with no grant are forgotten after a day, so a stream of registrations cannot grow the file forever. */
  private pruneClients(): void {
    const used = new Set(this.state.grants.map((grant) => grant.clientId));
    const cutoff = this.now() - UNUSED_CLIENT_TTL_MS;
    this.state.clients = this.state.clients.filter((client) =>
      used.has(client.clientId) || Date.parse(client.lastUsedAt) > cutoff);
  }

  // ── Grants ──

  listGrants(): AiConnectorGrant[] {
    return this.state.grants.map((grant) => ({ ...grant }));
  }

  getGrant(grantId: string): AiConnectorGrant | undefined {
    const grant = this.state.grants.find((entry) => entry.grantId === grantId);
    return grant ? { ...grant } : undefined;
  }

  grantForKey(publicKey: string): AiConnectorGrant | undefined {
    const grant = this.state.grants.find((entry) => entry.publicKey === publicKey);
    return grant ? { ...grant } : undefined;
  }

  grantForSession(sessionId: string): AiConnectorGrant | undefined {
    const grant = this.state.grants.find((entry) => entry.sessionId === sessionId);
    return grant ? { ...grant } : undefined;
  }

  createGrant(grant: Omit<AiConnectorGrant, "grantId" | "createdAt" | "lastUsedAt">): AiConnectorGrant {
    const stamp = new Date(this.now()).toISOString();
    const record: AiConnectorGrant = { ...grant, grantId: crypto.randomUUID(), createdAt: stamp, lastUsedAt: stamp };
    this.state.grants.push(record);
    this.write();
    return { ...record };
  }

  /** Drops the grant and every token issued for it. Returns the removed grant. */
  revokeGrant(grantId: string): AiConnectorGrant | undefined {
    const grant = this.state.grants.find((entry) => entry.grantId === grantId);
    if (!grant) return undefined;
    this.state.grants = this.state.grants.filter((entry) => entry !== grant);
    this.state.tokens = this.state.tokens.filter((token) => token.grantId !== grantId);
    this.pruneClients();
    this.write();
    return { ...grant };
  }

  revokeGrantForKey(publicKey: string): AiConnectorGrant | undefined {
    const grant = this.state.grants.find((entry) => entry.publicKey === publicKey);
    return grant ? this.revokeGrant(grant.grantId) : undefined;
  }

  /** Drops the grant only if no token was ever issued for it: an approval the client never redeemed. */
  revokeUnredeemedGrant(grantId: string): AiConnectorGrant | undefined {
    if (this.state.tokens.some((token) => token.grantId === grantId)) return undefined;
    return this.revokeGrant(grantId);
  }

  /**
   * Grants older than maxAgeMs that never got a token. A sign-in the client
   * abandoned after the phone approved it leaves one of these; they can
   * never be used, so they are removed and returned for the caller to drop
   * their device entries too.
   */
  pruneUnredeemedGrants(maxAgeMs: number): AiConnectorGrant[] {
    const cutoff = this.now() - maxAgeMs;
    const redeemed = new Set(this.state.tokens.map((token) => token.grantId));
    const dead = this.state.grants.filter((grant) => !redeemed.has(grant.grantId) && Date.parse(grant.createdAt) <= cutoff);
    if (dead.length === 0) return [];
    const gone = new Set(dead.map((grant) => grant.grantId));
    this.state.grants = this.state.grants.filter((grant) => !gone.has(grant.grantId));
    this.pruneClients();
    this.write();
    return dead.map((grant) => ({ ...grant }));
  }

  /** The client used its grant: a bearer request, so Devices can show when it was last seen. */
  touchGrant(grantId: string): void {
    const grant = this.state.grants.find((entry) => entry.grantId === grantId);
    if (!grant) return;
    grant.lastUsedAt = new Date(this.now()).toISOString();
    this.write();
  }

  // ── Tokens ──

  /** A fresh access and refresh token pair for the grant. */
  issueTokens(grantId: string): IssuedTokens {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = this.now();
    this.expireTokens();
    this.state.tokens.push(
      { hash: hashToken(accessToken), kind: "access", grantId, issuedAt: now, expiresAt: now + ACCESS_TOKEN_TTL_MS },
      { hash: hashToken(refreshToken), kind: "refresh", grantId, issuedAt: now, expiresAt: now + REFRESH_TOKEN_TTL_MS },
    );
    const grant = this.state.grants.find((entry) => entry.grantId === grantId);
    if (grant) grant.lastUsedAt = new Date(now).toISOString();
    this.write();
    return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
  }

  /** The grant an unexpired access token belongs to. */
  grantForAccessToken(token: string): AiConnectorGrant | undefined {
    const hash = hashToken(token);
    const record = this.state.tokens.find((entry) => entry.kind === "access" && entry.hash === hash);
    if (!record || record.expiresAt <= this.now()) return undefined;
    return this.getGrant(record.grantId);
  }

  /**
   * Rotates a refresh token. The old one stops working at once; a reuse inside
   * the grace window is treated as a retry, a later reuse as theft and the
   * whole grant is revoked.
   */
  rotateRefreshToken(token: string): { ok: true; tokens: IssuedTokens; grant: AiConnectorGrant } | { ok: false; error: string } {
    const hash = hashToken(token);
    const now = this.now();
    const record = this.state.tokens.find((entry) => entry.kind === "refresh" && entry.hash === hash);
    if (!record || record.expiresAt <= now) return { ok: false, error: "The refresh token is unknown or expired" };
    if (record.supersededAt !== undefined && now - record.supersededAt > REFRESH_REUSE_GRACE_MS) {
      this.revokeGrant(record.grantId);
      console.warn("[AI connector] A rotated refresh token was reused; its grant is revoked. Sign in again from the AI client.");
      return { ok: false, error: "The refresh token was already used" };
    }
    const grant = this.getGrant(record.grantId);
    if (!grant) return { ok: false, error: "The grant was revoked" };
    record.supersededAt ??= now;
    // The grant's newest refresh token is the only one that still rotates.
    for (const other of this.state.tokens) {
      if (other.kind === "refresh" && other.grantId === grant.grantId && other !== record && other.supersededAt === undefined) {
        other.supersededAt = now;
      }
    }
    const tokens = this.issueTokens(grant.grantId);
    return { ok: true, tokens, grant };
  }

  /** RFC 7009: forgets one token of either kind. Unknown tokens are ignored. */
  revokeToken(token: string): void {
    const hash = hashToken(token);
    const before = this.state.tokens.length;
    this.state.tokens = this.state.tokens.filter((entry) => entry.hash !== hash);
    if (this.state.tokens.length !== before) this.write();
  }

  private expireTokens(): void {
    const now = this.now();
    this.state.tokens = this.state.tokens.filter((entry) => entry.expiresAt > now);
  }
}
