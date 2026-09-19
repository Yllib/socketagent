const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isAuthFailureMessage,
  claudeAuthStateFromCredentials,
  codexAuthStateFromAuthJson,
} = require("../dist/backend-auth");

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 19);

test("rejected credentials are recognised however the harness words them", () => {
  for (const message of [
    "OAuth token has expired",
    "Authentication failed",
    "invalid credentials",
    "token_invalidated",
    "Please run /login to sign in again",
    "Request failed: 401",
    "unauthorized",
    "not authenticated",
    "Your session has expired, sign in again",
  ]) {
    assert.ok(isAuthFailureMessage(new Error(message)), message);
  }
});

test("ordinary turn failures are not auth failures", () => {
  for (const message of [
    "Query failed",
    "ENOENT: no such file or directory",
    "Request timed out after 30000ms",
    "rate limit exceeded",
    "Tool use was rejected by the user",
  ]) {
    assert.equal(isAuthFailureMessage(new Error(message)), false, message);
  }
});

// A connector's own expired token is not the backend's, and sending the user
// to re-authenticate Claude would not fix it.
test("an MCP server's auth failure is not the backend's", () => {
  assert.equal(
    isAuthFailureMessage(new Error("MCP server \"github\" authentication expired")),
    false,
  );
});

test("a live Claude sign-in reads as authenticated", () => {
  const state = claudeAuthStateFromCredentials(
    { claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: NOW + HOUR } },
    {},
    NOW,
  );
  assert.equal(state.authenticated, true);
});

// The CLI refreshes an aged-out access token on use and rewrites the file, so
// flagging this would report an auth error during normal operation.
test("an expired access token with a refresh token is not a logout", () => {
  const state = claudeAuthStateFromCredentials(
    { claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: NOW - HOUR } },
    {},
    NOW,
  );
  assert.equal(state.authenticated, true);
});

test("an expired sign-in with no way to refresh is a logout", () => {
  const expired = claudeAuthStateFromCredentials(
    { claudeAiOauth: { accessToken: "a", expiresAt: NOW - HOUR } },
    {},
    NOW,
  );
  assert.equal(expired.authenticated, false);
  assert.match(expired.reason, /expired/i);

  const deadRefresh = claudeAuthStateFromCredentials(
    {
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: NOW + HOUR,
        refreshTokenExpiresAt: NOW - HOUR,
      },
    },
    {},
    NOW,
  );
  assert.equal(deadRefresh.authenticated, false);
});

test("a missing or empty Claude credential reads as signed out", () => {
  assert.equal(claudeAuthStateFromCredentials(undefined, {}, NOW).authenticated, false);
  assert.equal(claudeAuthStateFromCredentials({}, {}, NOW).authenticated, false);
  assert.equal(
    claudeAuthStateFromCredentials({ claudeAiOauth: { accessToken: "" } }, {}, NOW).authenticated,
    false,
  );
});

test("an API key stands in for a Claude sign-in", () => {
  const state = claudeAuthStateFromCredentials(undefined, { ANTHROPIC_API_KEY: "sk-x" }, NOW);
  assert.equal(state.authenticated, true);
});

test("Codex accepts either an API key or an OAuth access token", () => {
  assert.equal(codexAuthStateFromAuthJson({ OPENAI_API_KEY: "sk-x" }).authenticated, true);
  assert.equal(
    codexAuthStateFromAuthJson({ tokens: { access_token: "t" } }).authenticated,
    true,
  );
});

test("a Codex record with neither credential reads as signed out", () => {
  const state = codexAuthStateFromAuthJson({ tokens: {} });
  assert.equal(state.authenticated, false);
  assert.match(state.reason, /sign-in/i);
  assert.equal(codexAuthStateFromAuthJson(null).authenticated, false);
});
