import { execFileSync } from "child_process";
import * as crypto from "crypto";
import { z } from "zod";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";

const OAUTH_CONFIG = {
  CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  AUTH_URL: "https://claude.ai/oauth/authorize",
  TOKEN_URL: "https://platform.claude.com/v1/oauth/token",
  REDIRECT_URI: "https://platform.claude.com/oauth/code/callback",
  SCOPES: ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"],
};

export interface ClaudeAuthRequest {
  codeVerifier: string;
  state: string;
  authUrl: string;
}

export function createClaudeAuthRequest(): ClaudeAuthRequest {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");

  const params = new URLSearchParams();
  params.append("code", "true");
  params.append("client_id", OAUTH_CONFIG.CLIENT_ID);
  params.append("response_type", "code");
  params.append("redirect_uri", OAUTH_CONFIG.REDIRECT_URI);
  params.append("scope", OAUTH_CONFIG.SCOPES.join(" "));
  params.append("code_challenge", codeChallenge);
  params.append("code_challenge_method", "S256");
  params.append("state", state);

  return {
    codeVerifier,
    state,
    authUrl: `${OAUTH_CONFIG.AUTH_URL}?${params.toString()}`,
  };
}

function parseSubmittedCode(rawCode: string): string {
  const raw = rawCode.trim();
  if (!raw) return raw;

  try {
    const url = new URL(raw);
    const code = url.searchParams.get("code");
    if (code) return code;
  } catch {}

  if (raw.includes("code=")) {
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
    const params = new URLSearchParams(query.split("#", 1)[0]);
    const code = params.get("code");
    if (code) return code;
  }

  return raw.split("#", 1)[0];
}

function credentialsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".claude", ".credentials.json");
}

const oauthTokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().nonnegative().optional(),
  scope: z.string().optional(),
});

/** Account name the Claude CLI files its Keychain item under. */
function keychainAccount(): string {
  let user: string;
  try {
    user = process.env.USER || os.userInfo().username;
  } catch {
    user = "claude-code-user";
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user";
}

/**
 * On macOS the Claude CLI reads its Keychain item before .credentials.json, so
 * a stale or cleared item there hides a fresh sign-in. Write the same record
 * the CLI would. The command goes over stdin so tokens stay out of `ps`.
 */
function saveToKeychain(json: string): void {
  const hex = Buffer.from(json, "utf8").toString("hex");
  const command = `add-generic-password -U -a "${keychainAccount()}" -s "Claude Code-credentials" -X "${hex}"\n`;
  try {
    execFileSync("security", ["-i"], { input: command, stdio: ["pipe", "ignore", "pipe"], timeout: 10_000 });
  } catch (e) {
    const stderr = e instanceof Error && "stderr" in e ? String(e.stderr).trim() : "";
    console.warn(`[Auth] Could not update the Claude Keychain item: ${stderr || (e instanceof Error ? e.message : String(e))}`);
  }
}

export function saveOAuthTokens(tokens: z.infer<typeof oauthTokensSchema>): void {
  const credPath = credentialsPath();
  const expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : Date.now() + 3600 * 1000;

  const credData = {
    claudeAiOauth: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt,
      scopes: tokens.scope ? tokens.scope.split(" ") : OAUTH_CONFIG.SCOPES,
      subscriptionType: null,
      rateLimitTier: null,
    },
  };

  const json = JSON.stringify(credData);
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  fs.writeFileSync(credPath, json, { mode: 0o600 });
  if (process.platform === "darwin") saveToKeychain(json);
}

export async function exchangeClaudeAuthCode(
  request: ClaudeAuthRequest,
  code: string
): Promise<void> {
  const authCode = parseSubmittedCode(code);
  if (!authCode) throw new Error("Claude auth code is empty.");

  const postData = JSON.stringify({
    grant_type: "authorization_code",
    code: authCode,
    redirect_uri: OAUTH_CONFIG.REDIRECT_URI,
    client_id: OAUTH_CONFIG.CLIENT_ID,
    code_verifier: request.codeVerifier,
    state: request.state,
  });

  const body = await new Promise<string>((resolve, reject) => {
    const url = new URL(OAUTH_CONFIG.TOKEN_URL);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    }, (res) => {
      let responseBody = "";
      res.on("data", (chunk: Buffer) => { responseBody += chunk.toString(); });
      res.on("end", () => {
        if (res.statusCode === 200) {
          resolve(responseBody);
          return;
        }
        reject(new Error(`Claude token exchange failed (${res.statusCode}): ${responseBody.slice(0, 300)}`));
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });

  const tokens = oauthTokensSchema.safeParse(JSON.parse(body));
  if (!tokens.success) throw new Error("Claude returned an invalid token response.");
  saveOAuthTokens(tokens.data);
}

