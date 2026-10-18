// Codex PreToolUse hook. Codex runs it before each shell command with the
// call as JSON on stdin. When the command pipes through a filter such as
// `tail`, it replies with the command plus a tee into a capture file named
// after the call, so the full stream can be kept. Codex runs PowerShell on
// Windows and the login shell elsewhere. Anything else gets no reply, which
// leaves the call as it was.

import * as fs from "fs";
import * as path from "path";
import { bashCapturePath } from "./bash-capture";
import { insertPowerShellTee, insertShellTee } from "./command-capture";
import { isRecord } from "./value-guards";

function rewrite(raw: string): string | null {
  const input: unknown = JSON.parse(raw);
  // apply_patch input also has a `command` field.
  if (!isRecord(input) || input.tool_name !== "Bash" || !isRecord(input.tool_input)) return null;
  const command = input.tool_input.command;
  const toolUseId = input.tool_use_id;
  if (typeof command !== "string" || typeof toolUseId !== "string") return null;
  const capturePath = bashCapturePath(toolUseId);
  const teed = process.platform === "win32"
    ? insertPowerShellTee(command, capturePath)
    : insertShellTee(command, capturePath);
  if (!teed) return null;
  fs.mkdirSync(path.dirname(capturePath), { recursive: true });
  fs.writeFileSync(capturePath, "");
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      // Codex applies updatedInput only with "allow". The call still goes
      // through Codex's approval policy and SocketAgent's approval callback.
      permissionDecision: "allow",
      updatedInput: { ...input.tool_input, command: teed },
    },
  });
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const reply = rewrite(raw);
    if (reply) process.stdout.write(reply);
  } catch {
    // A hook failure must never block the command.
  }
});
