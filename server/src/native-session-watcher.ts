import fs from "node:fs";
import path from "node:path";
import { claudeConfigDir, codexHomeDir } from "./backend-config-files";
import { errorMessage } from "./value-guards";

/**
 * Whether a path reported under a watched folder is a new session transcript.
 * Codex keeps `sessions/YYYY/MM/DD/rollout-*.jsonl`. Claude keeps
 * `projects/<folder>/<session>.jsonl`, with subagent transcripts nested deeper.
 */
export function isNativeSessionTranscript(backend: "codex" | "claude", relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (!name.endsWith(".jsonl")) return false;
  return backend === "codex" ? name.startsWith("rollout-") : parts.length === 2;
}

/**
 * Calls `onNewSession` when Codex or Claude creates a session transcript, so a
 * session started outside SocketAgent, such as in a terminal, reaches the
 * session list without waiting for the native list cache to expire. Appends to
 * existing transcripts are ignored, and bursts collapse into one call.
 * Returns a function that stops watching.
 */
export function watchNativeSessionFolders(
  onNewSession: () => void,
  folders = { codex: path.join(codexHomeDir(), "sessions"), claude: path.join(claudeConfigDir(), "projects") },
  debounceMs = 1500,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  const notify = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onNewSession();
    }, debounceMs);
    timer.unref?.();
  };
  const watchers = (["codex", "claude"] as const).flatMap((backend) => {
    const folder = folders[backend];
    try {
      // "rename" covers creation; plain appends arrive as "change".
      const watcher = fs.watch(folder, { recursive: true, persistent: false }, (event, filename) => {
        if (event === "rename" && filename && isNativeSessionTranscript(backend, filename)) notify();
      });
      watcher.on("error", (error) => console.warn(`[NativeSessions] stopped watching ${folder}: ${errorMessage(error)}`));
      return [watcher];
    } catch (error) {
      // A backend that was never used has no folder yet; its sessions still
      // appear when the list cache expires.
      console.warn(`[NativeSessions] not watching ${folder}: ${errorMessage(error)}`);
      return [];
    }
  });
  return () => {
    for (const watcher of watchers) watcher.close();
    if (timer) clearTimeout(timer);
  };
}
