import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { CodexAppServerClient } from "./codex-app-server-client";
import { buildCodexSpawn } from "./codex-env";
import { errorMessage } from "./value-guards";

// Registers codex-capture-hook.js as a Codex PreToolUse hook for the
// app-servers SocketAgent starts. Codex runs a hook only once its definition
// is trusted, so the first app-server start lists the hook and records its
// hash in the user's config.toml through Codex's own config writer, the same
// entry `/hooks` writes when a user trusts one by hand.

const HOOK_SCRIPT = path.join(__dirname, "codex-capture-hook.js");

const hooksListSchema = z.object({
  data: z.array(z.object({
    hooks: z.array(z.object({
      key: z.string(),
      source: z.string(),
      command: z.string().optional(),
      currentHash: z.string(),
      trustStatus: z.string(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

/** Codex runs hook commands with PowerShell on Windows and sh elsewhere. */
export function codexCaptureHookCommand(platform = process.platform, node = process.execPath, script = HOOK_SCRIPT): string {
  if (platform === "win32") {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    return `& ${quote(node)} ${quote(script)}`;
  }
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return `${quote(node)} ${quote(script)}`;
}

/** The `-c` override that adds the hook. A JSON string is a valid TOML basic string. */
export function codexCaptureHookOverride(command = codexCaptureHookCommand()): string {
  return `hooks.PreToolUse=[{matcher="^Bash$",hooks=[{type="command",command=${JSON.stringify(command)}}]}]`;
}

async function trustCaptureHook(): Promise<boolean> {
  const command = codexCaptureHookCommand();
  const codex = buildCodexSpawn(["-c", codexCaptureHookOverride(command), "app-server", "--listen", "stdio://"]);
  const client = new CodexAppServerClient({
    cwd: os.homedir(),
    command: codex.command,
    args: codex.args,
    env: codex.env,
    shell: codex.shell,
    requestTimeoutMs: 30_000,
    startupTimeoutMs: 30_000,
  });
  client.on("error", () => {
    // The pending request rejects too; this keeps a spawn failure from going uncaught.
  });
  try {
    await client.initialize({
      clientInfo: { name: "socketagent", title: "SocketAgent", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const listed = hooksListSchema.parse(await client.request("hooks/list", { cwds: [os.homedir()] }));
    const hook = listed.data.flatMap((entry) => entry.hooks)
      .find((candidate) => candidate.source === "sessionFlags" && candidate.command === command);
    if (!hook) {
      console.warn("[CodexCapture] Codex did not list the capture hook; full command output stays off");
      return false;
    }
    if (hook.trustStatus === "trusted") return true;
    await client.request("config/value/write", {
      keyPath: "hooks.state",
      value: { [hook.key]: { trusted_hash: hook.currentHash } },
      mergeStrategy: "upsert",
    });
    console.log(`[CodexCapture] Trusted the capture hook (${hook.currentHash})`);
    return true;
  } catch (err: unknown) {
    // Older Codex builds have no hooks; sessions then run without the hook.
    console.warn(`[CodexCapture] Hook setup failed; full command output stays off: ${errorMessage(err)}`);
    return false;
  } finally {
    await client.stop().catch(() => {});
  }
}

let trusted: Promise<boolean> | null = null;

/** Extra Codex arguments that add the capture hook, or none when it could not be trusted. */
export async function codexCaptureHookArgs(): Promise<string[]> {
  trusted ??= trustCaptureHook();
  return await trusted ? ["-c", codexCaptureHookOverride()] : [];
}
