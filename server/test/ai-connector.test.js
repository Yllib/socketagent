const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const {
  AiConnectorStore, ACCESS_TOKEN_TTL_MS, REFRESH_REUSE_GRACE_MS, REFRESH_TOKEN_TTL_MS,
} = require("#server/ai-connector-store");
const {
  AiConnectorOAuth, AuthorizeRedirectError, OAuthError, SIGN_IN_TTL_MS, AUTH_CODE_TTL_MS, MAX_PENDING_SIGN_INS,
  normalizePublicUrl, redirectUriAllowed,
} = require("#server/ai-connector-oauth");
const { AiConnectorHttp } = require("#server/ai-connector-http");
const { DeviceRegistry } = require("#server/device-registry");
const { ComputerLinkPeerApi } = require("#server/computer-link-peer");
const { generateKeyPair } = require("#server/relay-crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { UnauthorizedError } = require("@modelcontextprotocol/sdk/client/auth.js");
const { isRecord, unknownArray } = require("#server/value-guards");

let counter = 0;

/** @typedef {import("#server/ai-connector-oauth").PendingSignIn} PendingSignIn */
/** @typedef {import("#server/ai-connector-cimd").ClientMetadataDocument} ClientMetadataDocument */
/** @typedef {import("#server/computer-link-peer").PeerAction} PeerAction */

/** Reads a JSON body as a plain object so assertions stay typed. @param {Response} response */
async function jsonObject(response) {
  /** @type {unknown} */
  const body = await response.json();
  assert.ok(isRecord(body));
  return body;
}

/** The text of the first content block an MCP tool returned. @param {unknown} result */
function toolText(result) {
  assert.ok(isRecord(result));
  /** @type {unknown} */
  const first = unknownArray(result.content)[0];
  assert.ok(isRecord(first) && typeof first.text === "string");
  return first.text;
}

/** Narrows an OAuth error so its code can be asserted. @param {unknown} err */
function oauthError(err) {
  assert.ok(err instanceof OAuthError, err instanceof Error ? err.message : String(err));
  return err;
}

/**
 * A store, OAuth server and listener sharing one fake clock, with a host that records everything.
 * @param {{ fetchClientMetadata?: (clientId: string) => Promise<ClientMetadataDocument> }} options
 */
function setup(options = {}) {
  const clock = { now: 1_760_000_000_000 };
  const now = () => clock.now;
  const store = new AiConnectorStore(path.join(dataDir, `ai-connector-${++counter}.json`), now);
  /** @type {PendingSignIn[]} */
  const pending = [];
  /** @type {PendingSignIn["status"][]} */
  const settled = [];
  /** @type {string[]} */
  const granted = [];
  /** @type {string[]} */
  const abandoned = [];
  const oauth = new AiConnectorOAuth({
    store,
    now,
    serverName: () => "Desktop",
    signInPending: (signIn) => pending.push(signIn),
    signInSettled: (signIn) => settled.push(signIn.status),
    grantAccess: (signIn) => {
      granted.push(signIn.clientName);
      return { sessionId: `connector-${granted.length}` };
    },
    grantAbandoned: (grant) => abandoned.push(grant.publicKey),
    fetchClientMetadata: options.fetchClientMetadata,
  });
  /** @type {{ grant: string, computer: string | undefined, action: PeerAction, args: Record<string, unknown> }[]} */
  const acted = [];
  /** @type {{ kind: "call" | "result", session: string, toolUseId: string, tool?: string, input?: unknown, output?: string, isError?: boolean }[]} */
  const logged = [];
  /** @type {string[]} */
  const seen = [];
  const http = new AiConnectorHttp({
    oauth,
    now,
    grantSeen: (grant) => seen.push(grant.grantId),
    serverName: () => "Desktop",
    listComputers: () => [{ name: "Laptop", publicKey: "k", linked: true, online: true }],
    act: async (grant, computer, action, args) => {
      acted.push({ grant: grant.grantId, computer, action, args });
      return { ran: action };
    },
    logCall: (grant, toolUseId, tool, input) => logged.push({ kind: "call", session: grant.sessionId, toolUseId, tool, input }),
    logResult: (grant, toolUseId, output, isError) => logged.push({ kind: "result", session: grant.sessionId, toolUseId, output, isError }),
  });
  return { clock, store, oauth, http, pending, settled, granted, abandoned, seen, acted, logged };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Registers a public client, starts a sign-in and approves it on the "phone". Returns what the token endpoint needs.
 * @param {ReturnType<typeof setup>} env @param {Record<string, string>} overrides
 */
async function signIn(env, overrides = {}) {
  const registration = env.oauth.register({
    client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none",
  });
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code", client_id: registration.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: env.oauth.resourceUrl, ...overrides,
  });
  const started = await env.oauth.authorize(query);
  assert.equal(env.oauth.approveSignIn(started.publicKey), true);
  const location = new URL(env.oauth.redirectFor(started.requestId) ?? "");
  const code = location.searchParams.get("code") ?? "";
  return { registration, verifier, code, location, started };
}

test("store issues, validates, expires and rotates tokens", () => {
  const env = setup();
  const grant = env.store.createGrant({ clientId: "c1", clientName: "Claude", publicKey: "key1", sessionId: "s1" });
  const first = env.store.issueTokens(grant.grantId);
  assert.equal(env.store.grantForAccessToken(first.accessToken)?.grantId, grant.grantId);
  assert.equal(env.store.grantForAccessToken("nope"), undefined);

  env.clock.now += ACCESS_TOKEN_TTL_MS + 1;
  assert.equal(env.store.grantForAccessToken(first.accessToken), undefined, "access tokens expire after an hour");

  const rotated = env.store.rotateRefreshToken(first.refreshToken);
  assert.equal(rotated.ok, true);
  assert.notEqual(rotated.tokens.refreshToken, first.refreshToken);
  assert.equal(env.store.grantForAccessToken(rotated.tokens.accessToken)?.grantId, grant.grantId);

  // A retry inside the grace window is a lost response, not an attack.
  env.clock.now += REFRESH_REUSE_GRACE_MS - 1;
  const retried = env.store.rotateRefreshToken(first.refreshToken);
  assert.equal(retried.ok, true);
  assert.ok(env.store.getGrant(grant.grantId));

  // A reuse after the grace window revokes the whole grant.
  env.clock.now += REFRESH_REUSE_GRACE_MS + 1;
  const reused = env.store.rotateRefreshToken(first.refreshToken);
  assert.equal(reused.ok, false);
  assert.equal(env.store.getGrant(grant.grantId), undefined, "grant revoked on refresh token reuse");
  assert.equal(env.store.grantForAccessToken(retried.tokens.accessToken), undefined);
  assert.equal(env.store.rotateRefreshToken(retried.tokens.refreshToken).ok, false);
});

test("store token hashes survive a reload and refresh tokens expire", () => {
  const file = path.join(dataDir, `ai-connector-reload-${++counter}.json`);
  const clock = { now: 1_760_000_000_000 };
  const store = new AiConnectorStore(file, () => clock.now);
  const grant = store.createGrant({ clientId: "c1", clientName: "Claude", publicKey: "key1", sessionId: "s1" });
  const tokens = store.issueTokens(grant.grantId);
  const raw = require("node:fs").readFileSync(file, "utf8");
  assert.ok(!raw.includes(tokens.accessToken) && !raw.includes(tokens.refreshToken), "plaintext tokens never touch disk");
  const reloaded = new AiConnectorStore(file, () => clock.now);
  assert.equal(reloaded.grantForAccessToken(tokens.accessToken)?.grantId, grant.grantId);
  clock.now += REFRESH_TOKEN_TTL_MS + 1;
  assert.equal(reloaded.rotateRefreshToken(tokens.refreshToken).ok, false);
});

test("registration validates redirect URIs and auth methods", () => {
  const env = setup();
  assert.throws(() => env.oauth.register({ redirect_uris: [] }), (err) => err instanceof OAuthError && err.code === "invalid_client_metadata");
  assert.throws(() => env.oauth.register({ redirect_uris: ["http://evil.example/cb"] }), (err) => err instanceof OAuthError && err.code === "invalid_redirect_uri");
  assert.throws(() => env.oauth.register({ redirect_uris: ["https://ok.example/cb"], token_endpoint_auth_method: "private_key_jwt" }), (err) => oauthError(err).code === "invalid_client_metadata");
  assert.throws(() => env.oauth.register({ redirect_uris: ["https://ok.example/cb"], grant_types: ["client_credentials"] }), (err) => oauthError(err).code === "invalid_client_metadata");
  const confidential = env.oauth.register({ redirect_uris: ["https://ok.example/cb", "http://localhost/callback"] });
  assert.equal(confidential.token_endpoint_auth_method, "client_secret_basic");
  assert.ok(typeof confidential.client_secret === "string" && confidential.client_secret.length > 20);
  assert.equal(confidential.client_name, "AI client");
  const publicClient = env.oauth.register({ redirect_uris: ["https://ok.example/cb"], token_endpoint_auth_method: "none", client_name: " Claude\u0000 " });
  assert.equal(publicClient.client_secret, undefined);
  assert.equal(publicClient.client_name, "Claude");
});

test("redirect URIs match exactly except loopback ports, and the public URL is an origin", () => {
  assert.equal(redirectUriAllowed(["https://claude.ai/api/mcp/auth_callback"], "https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(redirectUriAllowed(["https://claude.ai/api/mcp/auth_callback"], "https://claude.ai/api/mcp/auth_callback?x=1"), false);
  assert.equal(redirectUriAllowed(["http://localhost/callback"], "http://localhost:3118/callback"), true);
  assert.equal(redirectUriAllowed(["http://127.0.0.1/callback"], "http://127.0.0.1:5000/callback"), true);
  assert.equal(redirectUriAllowed(["http://localhost/callback"], "http://localhost:3118/other"), false);
  assert.equal(redirectUriAllowed(["https://a.example/cb"], "https://a.example:444/cb"), false);
  assert.equal(normalizePublicUrl("https://Agent.Example.com/"), "https://agent.example.com");
  assert.equal(normalizePublicUrl("http://127.0.0.1:8086"), "http://127.0.0.1:8086");
  assert.throws(() => normalizePublicUrl("http://agent.example.com"), /https/);
  assert.throws(() => normalizePublicUrl("https://agent.example.com/mcp"), /no path/);
  assert.throws(() => normalizePublicUrl("agent.example.com"), /full address/);
});

test("authorize rejects what it cannot trust and redirects what it can", async () => {
  const env = setup();
  env.store.saveSettings({ publicUrl: "https://agent.example.com" });
  const { client_id: clientId } = env.oauth.register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" });
  const { challenge } = pkce();
  const base = { response_type: "code", client_id: clientId, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256" };

  await assert.rejects(env.oauth.authorize(new URLSearchParams({ ...base, client_id: "unknown" })), (err) => err instanceof OAuthError && err.code === "invalid_client");
  await assert.rejects(env.oauth.authorize(new URLSearchParams({ ...base, redirect_uri: "https://evil.example/cb" })), (err) => err instanceof OAuthError && err.code === "invalid_request");
  await assert.rejects(env.oauth.authorize(new URLSearchParams({ ...base, code_challenge_method: "plain" })), (err) => err instanceof AuthorizeRedirectError && err.code === "invalid_request");
  await assert.rejects(env.oauth.authorize(new URLSearchParams({ ...base, code_challenge: "" })), (err) => err instanceof AuthorizeRedirectError);
  await assert.rejects(env.oauth.authorize(new URLSearchParams({ ...base, response_type: "token" })), (err) => err instanceof AuthorizeRedirectError && err.code === "unsupported_response_type");
  await assert.rejects(env.oauth.authorize(new URLSearchParams({ ...base, resource: "https://other.example/mcp" })), (err) => err instanceof AuthorizeRedirectError && err.code === "invalid_target");
  /** @type {unknown} */
  const error = await env.oauth.authorize(new URLSearchParams({ ...base, state: "s1", response_type: "token" })).catch((/** @type {unknown} */ err) => err);
  assert.ok(error instanceof AuthorizeRedirectError);
  const redirect = new URL(env.oauth.errorRedirect(error));
  assert.equal(redirect.searchParams.get("error"), "unsupported_response_type");
  assert.equal(redirect.searchParams.get("state"), "s1");
  assert.equal(redirect.searchParams.get("iss"), "https://agent.example.com");

  // Too many sign-ins waiting on the phone are refused rather than queued.
  for (let i = 0; i < MAX_PENDING_SIGN_INS; i++) await env.oauth.authorize(new URLSearchParams(base));
  await assert.rejects(env.oauth.authorize(new URLSearchParams(base)), (err) => err instanceof AuthorizeRedirectError && err.code === "temporarily_unavailable");
  assert.equal(env.pending.length, MAX_PENDING_SIGN_INS);
  assert.ok(env.pending.every((entry) => /^\d{6}$/.test(entry.code)), "each sign-in shows a six digit code");
});

test("approval on the phone issues a one-time code that needs the PKCE verifier", async () => {
  const env = setup();
  env.store.saveSettings({ publicUrl: "https://agent.example.com" });
  const { registration, verifier, code, location, started } = await signIn(env);
  assert.deepEqual(env.granted, ["Claude"]);
  assert.deepEqual(env.settled, ["approved"]);
  assert.equal(location.origin + location.pathname, "https://claude.ai/api/mcp/auth_callback");
  assert.equal(location.searchParams.get("state"), "xyz");
  assert.equal(location.searchParams.get("iss"), "https://agent.example.com");
  assert.ok(code);
  // The browser only gets the code once.
  assert.equal(new URL(env.oauth.redirectFor(started.requestId) ?? "").searchParams.get("error"), "access_denied");

  const tokenRequest = { grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", resource: env.oauth.resourceUrl };
  assert.throws(() => env.oauth.token({ ...tokenRequest, code, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-wrong" }), (err) => oauthError(err).code === "invalid_grant");
  // A failed exchange burns the code.
  assert.throws(() => env.oauth.token({ ...tokenRequest, code, code_verifier: verifier }), (err) => oauthError(err).code === "invalid_grant");

  const other = await signIn(env);
  assert.throws(() => env.oauth.token({ ...tokenRequest, client_id: registration.client_id, code: other.code, code_verifier: other.verifier }), (err) => oauthError(err).code === "invalid_grant", "a code is bound to its client");
  assert.equal(env.store.grantForKey(other.started.publicKey), undefined, "a burned code takes its unredeemed grant with it");
  assert.ok(env.abandoned.includes(other.started.publicKey));

  const again = await signIn(env);
  const tokens = env.oauth.token({ ...tokenRequest, client_id: again.registration.client_id, code: again.code, code_verifier: again.verifier });
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, ACCESS_TOKEN_TTL_MS / 1000);
  assert.ok(env.oauth.authenticateBearer(`Bearer ${tokens.access_token}`));
  assert.throws(() => env.oauth.token({ ...tokenRequest, client_id: again.registration.client_id, code: again.code, code_verifier: again.verifier }), (err) => oauthError(err).code === "invalid_grant", "codes are single use");

  const refreshed = env.oauth.token({ grant_type: "refresh_token", client_id: again.registration.client_id, refresh_token: tokens.refresh_token });
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  assert.throws(() => env.oauth.token({ grant_type: "refresh_token", client_id: registration.client_id, refresh_token: refreshed.refresh_token }), (err) => oauthError(err).code === "invalid_grant", "another client cannot refresh");
  assert.throws(() => env.oauth.token({ grant_type: "password", client_id: again.registration.client_id }), (err) => oauthError(err).code === "unsupported_grant_type");

  // Removing the client in the app ends everything at once.
  env.oauth.revokeKey(again.started.publicKey);
  assert.equal(env.oauth.authenticateBearer(`Bearer ${refreshed.access_token}`), undefined);
  assert.throws(() => env.oauth.token({ grant_type: "refresh_token", client_id: again.registration.client_id, refresh_token: refreshed.refresh_token }), (err) => oauthError(err).code === "invalid_grant");
});

test("an approval the client never redeems is dropped with its device entry", async () => {
  const env = setup();
  env.store.saveSettings({ publicUrl: "https://agent.example.com" });
  const { started, code, registration, verifier } = await signIn(env);
  assert.ok(env.store.grantForKey(started.publicKey), "approval creates the grant at once");
  env.clock.now += AUTH_CODE_TTL_MS + 1;
  env.oauth.pendingSignIns();
  assert.equal(env.store.grantForKey(started.publicKey), undefined);
  assert.deepEqual(env.abandoned, [started.publicKey]);
  assert.throws(() => env.oauth.token({ grant_type: "authorization_code", client_id: registration.client_id, code, code_verifier: verifier }), (err) => oauthError(err).code === "invalid_grant");

  // A redeemed grant is never touched by this, however old it gets.
  const live = await signIn(env);
  env.oauth.token({ grant_type: "authorization_code", client_id: live.registration.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code: live.code, code_verifier: live.verifier });
  env.clock.now += AUTH_CODE_TTL_MS * 10;
  env.oauth.pendingSignIns();
  assert.ok(env.store.grantForKey(live.started.publicKey));
  assert.equal(env.abandoned.length, 1);
});

test("startup prunes grants that never got a token, shaped like a store after failed attempts", () => {
  const file = path.join(dataDir, `ai-connector-prune-${++counter}.json`);
  const clock = { now: Date.parse("2026-10-28T04:24:00.000Z") };
  const store = new AiConnectorStore(file, () => clock.now);
  // One CIMD client, four grants from the same account's attempts, only the last one redeemed.
  store.saveClient({ clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata", clientName: "Claude", redirectUris: ["https://claude.ai/api/mcp/auth_callback"], tokenEndpointAuthMethod: "none", via: "cimd" });
  const grant = (/** @type {string} */ key, /** @type {number} */ offsetMs) => {
    clock.now = Date.parse("2026-10-28T04:24:33.000Z") + offsetMs;
    return store.createGrant({ clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata", clientName: "Claude", publicKey: key, sessionId: `connector-${key}` });
  };
  const first = grant("M83cvN", 0);
  const second = grant("qjzzax", 165_000);
  const third = grant("lARB5V", 167_000);
  const live = grant("18IDW/", 181_000);
  const tokens = store.issueTokens(live.grantId);
  // A fifth account signed in a moment ago and has not finished yet.
  const fresh = grant("young1", 20 * 60_000);
  clock.now = Date.parse("2026-10-28T04:24:33.000Z") + 21 * 60_000;

  const restarted = new AiConnectorStore(file, () => clock.now);
  const dropped = restarted.pruneUnredeemedGrants(AUTH_CODE_TTL_MS);
  assert.deepEqual(dropped.map((entry) => entry.grantId).sort(), [first.grantId, second.grantId, third.grantId].sort());
  assert.deepEqual(restarted.listGrants().map((entry) => entry.publicKey), ["18IDW/", "young1"]);
  assert.equal(restarted.grantForAccessToken(tokens.accessToken)?.grantId, live.grantId, "the live connection keeps its tokens");
  assert.ok(restarted.getClient("https://claude.ai/oauth/mcp-oauth-client-metadata"), "the shared client ID stays while a grant uses it");
  assert.deepEqual(restarted.pruneUnredeemedGrants(AUTH_CODE_TTL_MS), [], "a second pass finds nothing");
  assert.equal(fresh.grantId, restarted.listGrants()[1].grantId);
  // Two grants from one client ID are two sign-ins, never merged.
  assert.equal(restarted.listGrants().filter((entry) => entry.clientId === live.clientId).length, 2);
});

test("an unreadable grants file is reported, so startup leaves AI client devices alone", () => {
  const missing = new AiConnectorStore(path.join(dataDir, `ai-connector-${++counter}.json`));
  assert.equal(missing.readFailed, false, "no file yet is a fresh start");
  const file = path.join(dataDir, `ai-connector-${++counter}.json`);
  require("node:fs").writeFileSync(file, JSON.stringify({ version: 1, grants: [{ grantId: "half" }] }));
  const broken = new AiConnectorStore(file);
  assert.equal(broken.readFailed, true);
  assert.deepEqual(broken.listGrants(), []);
});

test("confidential clients must present their secret", async () => {
  const env = setup();
  env.store.saveSettings({ publicUrl: "https://agent.example.com" });
  const registration = env.oauth.register({ redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "client_secret_post" });
  const { verifier, challenge } = pkce();
  const started = await env.oauth.authorize(new URLSearchParams({
    response_type: "code", client_id: registration.client_id, code_challenge: challenge, code_challenge_method: "S256",
  }));
  env.oauth.approveSignIn(started.publicKey);
  const code = new URL(env.oauth.redirectFor(started.requestId) ?? "").searchParams.get("code") ?? "";
  assert.throws(() => env.oauth.token({ grant_type: "authorization_code", client_id: registration.client_id, code, code_verifier: verifier }), (err) => oauthError(err).code === "invalid_client" && oauthError(err).status === 401);
  assert.throws(() => env.oauth.token({ grant_type: "authorization_code", client_id: registration.client_id, client_secret: "wrong", code, code_verifier: verifier }), (err) => oauthError(err).code === "invalid_client");
  const tokens = env.oauth.token({ grant_type: "authorization_code", basic: { clientId: registration.client_id, clientSecret: registration.client_secret }, code, code_verifier: verifier });
  assert.ok(tokens.access_token);
});

test("denied and expired sign-ins send the browser back with access_denied", async () => {
  const env = setup();
  env.store.saveSettings({ publicUrl: "https://agent.example.com" });
  const { client_id: clientId } = env.oauth.register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" });
  const query = () => new URLSearchParams({ response_type: "code", client_id: clientId, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "d" });
  const denied = await env.oauth.authorize(query());
  assert.equal(env.oauth.redirectFor(denied.requestId), undefined, "nothing to redirect to while pending");
  assert.equal(env.oauth.denySignIn(denied.publicKey), true);
  assert.equal(env.oauth.denySignIn(denied.publicKey), false);
  const back = new URL(env.oauth.redirectFor(denied.requestId));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), "d");
  assert.deepEqual(env.granted, []);

  const expired = await env.oauth.authorize(query());
  env.clock.now += SIGN_IN_TTL_MS + 1;
  assert.equal(env.oauth.approveSignIn(expired.publicKey), false, "an expired sign-in cannot be approved");
  assert.equal(new URL(env.oauth.redirectFor(expired.requestId)).searchParams.get("error"), "access_denied");
  assert.deepEqual(env.settled, ["denied", "expired"]);
});

test("a client ID metadata document identifies a client without registration", async () => {
  /** @type {string[]} */
  const fetched = [];
  const env = setup({
    fetchClientMetadata: async (clientId) => {
      fetched.push(clientId);
      return {
        client_id: clientId, client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/abc"],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      };
    },
  });
  env.store.saveSettings({ publicUrl: "https://agent.example.com" });
  const clientId = "https://chatgpt.com/oauth/client.json";
  const { verifier, challenge } = pkce();
  const started = await env.oauth.authorize(new URLSearchParams({ response_type: "code", client_id: clientId, code_challenge: challenge, code_challenge_method: "S256" }));
  assert.equal(started.clientName, "ChatGPT");
  assert.equal(started.redirectUri, "https://chatgpt.com/connector/oauth/abc");
  await env.oauth.authorize(new URLSearchParams({ response_type: "code", client_id: clientId, code_challenge: challenge, code_challenge_method: "S256" }));
  assert.equal(fetched.length, 1, "the document is cached");
  env.oauth.approveSignIn(started.publicKey);
  const code = new URL(env.oauth.redirectFor(started.requestId) ?? "").searchParams.get("code") ?? "";
  const tokens = env.oauth.token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier });
  assert.ok(tokens.access_token);
  await assert.rejects(env.oauth.authorize(new URLSearchParams({ response_type: "code", client_id: "https://chatgpt.com", code_challenge: challenge, code_challenge_method: "S256" })), (err) => oauthError(err).code === "invalid_client", "a bare origin is not a metadata URL");
});

test("the peer API treats a connector key like a linked computer", async () => {
  const registry = new DeviceRegistry(path.join(dataDir, `connector-registry-${++counter}.json`), true);
  const key = crypto.randomBytes(32).toString("base64");
  registry.enroll({ publicKey: key, kind: "connector", name: "Claude", platform: "connector", via: "connector", access: { read: true, agents: true, commands: false }, confirm: "never" });
  /** @type {string[]} */
  const ran = [];
  const api = new ComputerLinkPeerApi(registry, generateKeyPair(), {
    serverName: () => "Desktop", backends: () => ["claude"], listSessions: () => [{ id: "s1", title: "T", backend: "claude", cwd: "/", updatedAt: "", running: false }],
    readTranscript: () => { throw new Error("unused"); }, searchTranscripts: async () => [],
    runCommand: async (request) => { ran.push(request.command); return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false }; },
    agent: async () => { throw new Error("unused"); }, ackAgentReport: () => {},
  });
  const sessions = await api.handle({ type: "peer_request", id: "1", action: "sessions_list", args: {}, sourceSessionId: "connector-1" }, key);
  assert.equal(sessions.ok, true);
  const command = await api.handle({ type: "peer_request", id: "2", action: "run_command", args: { command: "ls" }, sourceSessionId: "connector-1" }, key);
  assert.equal(command.ok, false);
  assert.equal(command.code, "access_denied");
  assert.deepEqual(ran, []);
  const stranger = await api.handle({ type: "peer_request", id: "3", action: "sessions_list", args: {}, sourceSessionId: "" }, crypto.randomBytes(32).toString("base64"));
  assert.equal(stranger.code, "access_denied");
});

/**
 * Drives the real MCP client through discovery, registration, PKCE, phone approval and tool calls.
 * @param {ReturnType<typeof setup>} env @param {string} baseUrl
 */
async function connectClient(env, baseUrl) {
  /** @type {import("@modelcontextprotocol/sdk/shared/auth.js").OAuthTokens | undefined} */
  let stored;
  /** @type {import("@modelcontextprotocol/sdk/shared/auth.js").OAuthClientInformationMixed | undefined} */
  let clientInfo;
  let verifier = "";
  /** @type {URL | undefined} */
  let authorizationUrl;
  /** @type {import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider} */
  const provider = {
    get redirectUrl() { return "https://claude.ai/api/mcp/auth_callback"; },
    get clientMetadata() {
      return { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
    },
    clientInformation: () => clientInfo,
    saveClientInformation: (info) => { clientInfo = info; },
    tokens: () => stored,
    saveTokens: (tokens) => { stored = tokens; },
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => verifier,
    redirectToAuthorization: (url) => { authorizationUrl = url; },
  };
  const state = { get tokens() { return stored; }, get client() { return clientInfo; } };
  const mcpUrl = new URL("/mcp", baseUrl);
  const client = new Client({ name: "test", version: "1.0.0" });
  await assert.rejects(client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider })), (err) => err instanceof UnauthorizedError);
  assert.ok(authorizationUrl, "the client was sent to the authorize page");

  // The browser opens the page, which parks on the waiting page until the phone answers.
  const authorize = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  const waitUrl = new URL(authorize.headers.get("location") ?? "", baseUrl);
  const waiting = await fetch(waitUrl);
  assert.equal(waiting.status, 200);
  const html = await waiting.text();
  assert.match(html, /Claude wants to use your computers/);
  assert.match(html, /claude\.ai/);
  const signIn = env.pending.at(-1);
  assert.ok(signIn);
  assert.match(html, new RegExp(`${signIn.code.slice(0, 3)} ${signIn.code.slice(3)}`), "the page shows the code the phone shows");
  assert.equal(signIn.clientName, "Claude");

  assert.equal(env.oauth.approveSignIn(signIn.publicKey), true);
  const done = await fetch(waitUrl, { redirect: "manual" });
  assert.equal(done.status, 302);
  const callback = new URL(done.headers.get("location") ?? "");
  assert.equal(callback.origin + callback.pathname, "https://claude.ai/api/mcp/auth_callback");
  const closing = await fetch(waitUrl);
  assert.match(await closing.text(), /Signed in/);

  const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  await transport.finishAuth(callback.searchParams.get("code") ?? "");
  assert.ok(stored?.access_token && stored.refresh_token);
  const connected = new Client({ name: "test", version: "1.0.0" });
  await connected.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
  return { client: connected, state, signIn };
}

test("the listener serves only the connector and runs the full flow with a real MCP client", async (t) => {
  const env = setup();
  await env.http.listen(0);
  t.after(() => env.http.close());
  const baseUrl = `http://127.0.0.1:${env.http.port}`;
  env.store.saveSettings({ enabled: true, publicUrl: baseUrl, port: env.http.port });

  // Nothing but MCP and OAuth is reachable here.
  for (const route of ["/internal/restart/health", "/codex-mcp/x", "/file/download", "/ws", "/.well-known/other"]) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 404, route);
  }
  assert.equal((await fetch(`${baseUrl}/`)).status, 200);

  const unauthenticated = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("www-authenticate"), `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`);
  const stale = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
  assert.equal(stale.status, 401);
  assert.match(stale.headers.get("www-authenticate"), /error="invalid_token"/);

  const resource = await jsonObject(await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`));
  assert.deepEqual(resource.authorization_servers, [baseUrl]);
  assert.equal(resource.resource, `${baseUrl}/mcp`);
  assert.deepEqual(await jsonObject(await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)), resource);
  const metadata = await jsonObject(await fetch(`${baseUrl}/.well-known/oauth-authorization-server`));
  assert.equal(metadata.issuer, baseUrl);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.ok(Array.isArray(metadata.token_endpoint_auth_methods_supported) && metadata.token_endpoint_auth_methods_supported.includes("none"));
  assert.deepEqual(await jsonObject(await fetch(`${baseUrl}/.well-known/openid-configuration`)), metadata);

  const { client, state, signIn } = await connectClient(env, baseUrl);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "agent_status", "list_agents", "list_computers", "list_sessions", "message_agent", "read_transcript",
    "run_command", "search_transcripts", "start_agent", "stop_agent",
  ]);

  const computers = await client.callTool({ name: "list_computers", arguments: {} });
  assert.ok(env.seen.includes(env.store.grantForKey(signIn.publicKey)?.grantId ?? ""), "an authenticated call marks the client seen");
  assert.match(toolText(computers), /"this_computer": "Desktop"/);
  assert.match(toolText(computers), /Laptop/);
  const ran = await client.callTool({ name: "run_command", arguments: { computer: "Laptop", command: "uname -a", timeout_seconds: 5 } });
  assert.equal(ran.isError, undefined);
  assert.deepEqual(env.acted.at(-1), { grant: env.store.grantForKey(signIn.publicKey)?.grantId, computer: "Laptop", action: "run_command", args: { command: "uname -a", timeoutSeconds: 5 } });
  const unnamed = await client.callTool({ name: "start_agent", arguments: { prompt: "Fix the build", backend: "codex", label: "fix" } });
  assert.equal(unnamed.isError, true, "start_agent must name the child's lifetime");
  assert.match(toolText(unnamed), /lifetime/);
  assert.match(toolText(unnamed), /fleeting/);
  assert.match(toolText(unnamed), /permanent/);
  const actedBefore = env.acted.length;
  const started = await client.callTool({ name: "start_agent", arguments: { prompt: "Fix the build", backend: "codex", label: "fix", lifetime: "fleeting" } });
  assert.equal(started.isError, undefined);
  assert.equal(env.acted.length, actedBefore + 1, "the refused call never reached a computer");
  assert.deepEqual(env.acted.at(-1), { grant: env.acted[0]?.grant, computer: undefined, action: "agent_start", args: { prompt: "Fix the build", lifetime: "fleeting", backend: "codex", label: "fix" } });
  const calls = env.logged.filter((entry) => entry.kind === "call").map((entry) => entry.tool);
  assert.deepEqual(calls, ["list_computers", "run_command", "start_agent"]);
  assert.ok(env.logged.every((entry) => entry.session === "connector-1"), "every action lands in the client's session");

  // The access token expires; the client refreshes without the user noticing.
  const before = state.tokens;
  env.clock.now += ACCESS_TOKEN_TTL_MS + 1000;
  const later = await client.callTool({ name: "list_sessions", arguments: {} });
  assert.equal(later.isError, undefined);
  assert.notEqual(state.tokens?.access_token, before?.access_token);
  assert.notEqual(state.tokens?.refresh_token, before?.refresh_token);

  // Revoking in the app ends the session; the next call is refused and the refresh token is dead.
  env.oauth.revokeKey(signIn.publicKey);
  await assert.rejects(client.callTool({ name: "list_sessions", arguments: {} }));
  const refresh = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: state.client?.client_id ?? "", refresh_token: state.tokens?.refresh_token ?? "" }),
  });
  assert.equal(refresh.status, 400);
  assert.equal((await jsonObject(refresh)).error, "invalid_grant");
});

test("the token endpoint rate limit answers 429 with Retry-After", async (t) => {
  const env = setup();
  await env.http.listen(0);
  t.after(() => env.http.close());
  const baseUrl = `http://127.0.0.1:${env.http.port}`;
  env.store.saveSettings({ enabled: true, publicUrl: baseUrl, port: env.http.port });
  /** @type {Response | undefined} */
  let last;
  for (let i = 0; i < 61; i++) {
    last = await fetch(`${baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&client_id=x&refresh_token=y" });
  }
  assert.equal(last?.status, 429);
  assert.equal(last?.headers.get("retry-after"), "60");
  env.clock.now += 60_001;
  const again = await fetch(`${baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&client_id=x&refresh_token=y" });
  assert.equal(again.status, 401, "the window reset; an unknown client is refused, not throttled");
});
