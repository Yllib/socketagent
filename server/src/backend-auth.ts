/**
 * Whether a backend's credentials are usable.
 *
 * Two signals, and both are needed. The credential files on disk say whether
 * anyone ever signed in, which is knowable before a turn runs. A failed turn
 * says whether the provider still accepts those credentials, which is the only
 * way to learn that a token was revoked server-side. Checking only the second
 * means the settings screen reports a healthy backend right up until the user
 * sends a message and it fails.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface BackendAuthState {
  authenticated: boolean;
  /** Why not, phrased for someone reading a settings screen. */
  reason?: string;
}

/**
 * True when an error from a backend reads as a rejected credential rather
 * than any other failure.
 *
 * Deliberately broad: the harnesses word this many ways, and a missed auth
 * error leaves the user staring at a generic failure with no idea they need
 * to sign in. A false positive costs a misleading label on a failed turn.
 *
 * An MCP server rejecting its own credentials is excluded. It reads exactly
 * like a backend auth failure and has nothing to do with the backend's own
 * sign-in; reporting it as one would send the user to re-authenticate Claude
 * over a broken connector.
 */
export function isAuthFailureMessage(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : (() => {
          try {
            return JSON.stringify(error);
          } catch {
            return String(error);
          }
        })();

  if (/\bmcp\b/i.test(message)) return false;

  // A credential noun and a failure word, in either order, is the shape all of
  // these errors share. Suffixes are open so "credentials" and "tokens" match.
  const subject = "(?:auth|authentication|authorize|authorization|login|sign[- ]?in|credential|token)s?";
  const failure = "(?:invalid(?:ated)?|expired|revoked|required|missing|failed|denied|rejected|unauthorized)";
  return new RegExp(`\\b${subject}\\b.{0,40}\\b${failure}\\b`, "i").test(message)
    || new RegExp(`\\b${failure}\\b.{0,40}\\b${subject}\\b`, "i").test(message)
    || /\btoken_invalidated\b/i.test(message)
    || /\b(?:sign|log)(?:ing)? in again\b/i.test(message)
    || /\b(?:signed|logged) out\b/i.test(message)
    || /\bnot authenticated\b/i.test(message)
    || /\bunauthorized\b/i.test(message)
    || /\b401\b/.test(message);
}

/**
 * Reads a Claude OAuth credential record.
 *
 * An expired access token is not a logout. The CLI refreshes it on use, and
 * the file is rewritten in place, so treating expiry as a failure would report
 * an auth error every time a token aged out normally. Only a record with no
 * way back — no access token, or an expired one with no refresh token — means
 * the user has to sign in again.
 */
export function claudeAuthStateFromCredentials(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): BackendAuthState {
  if ((env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "").trim()) {
    return { authenticated: true };
  }
  const oauth = (raw as any)?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    return { authenticated: false, reason: "Claude is not signed in on this computer." };
  }
  if (!String(oauth.accessToken || "").trim()) {
    return { authenticated: false, reason: "Claude's saved sign-in has no access token." };
  }

  const refreshExpiry = Number(oauth.refreshTokenExpiresAt);
  if (Number.isFinite(refreshExpiry) && refreshExpiry > 0 && refreshExpiry <= nowMs) {
    return { authenticated: false, reason: "Claude's sign-in has expired and cannot refresh." };
  }

  const expiry = Number(oauth.expiresAt);
  const canRefresh = String(oauth.refreshToken || "").trim().length > 0;
  if (Number.isFinite(expiry) && expiry > 0 && expiry <= nowMs && !canRefresh) {
    return { authenticated: false, reason: "Claude's sign-in has expired." };
  }
  return { authenticated: true };
}

/** Reads a Codex auth record. `auth_mode` of `apikey` needs no OAuth tokens. */
export function codexAuthStateFromAuthJson(raw: unknown): BackendAuthState {
  const auth = raw as any;
  if (!auth || typeof auth !== "object") {
    return { authenticated: false, reason: "Codex is not signed in on this computer." };
  }
  if (String(auth.OPENAI_API_KEY || "").trim()) return { authenticated: true };
  if (String(auth.tokens?.access_token || "").trim()) return { authenticated: true };
  return { authenticated: false, reason: "Codex's saved sign-in has no usable credentials." };
}

function readJsonFile(filePath: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || os.homedir();
}

/** Claude's sign-in state on this machine. */
export function readClaudeAuthState(env: NodeJS.ProcessEnv = process.env): BackendAuthState {
  const credentials = readJsonFile(
    path.join(homeDir(env), ".claude", ".credentials.json"),
  );
  return claudeAuthStateFromCredentials(credentials, env);
}

/** Codex's sign-in state on this machine. */
export function readCodexAuthState(env: NodeJS.ProcessEnv = process.env): BackendAuthState {
  const authPath = path.join(homeDir(env), ".codex", "auth.json");
  if (!fs.existsSync(authPath)) {
    return { authenticated: false, reason: "Codex is not signed in on this computer." };
  }
  return codexAuthStateFromAuthJson(readJsonFile(authPath));
}
