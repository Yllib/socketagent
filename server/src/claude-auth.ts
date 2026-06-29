import * as crypto from "crypto";
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

function saveOAuthTokens(tokens: any): void {
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

  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify(credData), { mode: 0o600 });
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
      res.on("data", (chunk) => { responseBody += chunk; });
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

  saveOAuthTokens(JSON.parse(body));
}

