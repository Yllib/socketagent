import * as crypto from "crypto";
import * as fs from "fs";

/** Rewrites one KEY=value line in a dotenv file, appending it when missing. */
export function writeEnvValue(envPath: string, key: string, value: string): void {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const content = pattern.test(existing)
    ? existing.replace(pattern, line)
    : `${existing.trimEnd()}\n${line}\n`;
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  }
}

/**
 * Makes a new AUTH_TOKEN and stores it in .env, the only durable copy. The
 * caller swaps the in-memory value and process.env so loopback routes, the
 * upgrade handler, direct E2E auth and later-spawned scripts all see it.
 */
export function rotateAuthTokenInEnv(envPath: string): string {
  const next = crypto.randomBytes(32).toString("hex");
  writeEnvValue(envPath, "AUTH_TOKEN", next);
  return next;
}
