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

// How deep transcripts sit below each watched folder, counting folders only.
const TRANSCRIPT_DEPTH = { codex: 3, claude: 1 } as const;

/**
 * Watches `root` and the folders below it down to `maxDepth`, one watch per
 * folder. Node's recursive watch on Linux adds an inotify watch for every
 * file too, which reached 11k watches on a busy machine. Folders created
 * later are added, and transcripts already inside them are reported, since
 * they can appear before the new watch does.
 */
function watchFolderTree(
  root: string,
  maxDepth: number,
  onCreated: (relativePath: string) => void,
): () => void {
  const watchers = new Map<string, fs.FSWatcher>();
  const add = (folder: string, depth: number, reportExisting: boolean): void => {
    if (watchers.has(folder)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(folder, { persistent: false }, (event, filename) => {
        if (event !== "rename" || !filename) return;
        const full = path.join(folder, filename.toString());
        let isFolder = false;
        try { isFolder = fs.statSync(full).isDirectory(); } catch { return; }
        if (isFolder) {
          if (depth < maxDepth) add(full, depth + 1, true);
        } else {
          onCreated(path.relative(root, full));
        }
      });
    } catch (error) {
      if (depth === 0) throw error;
      return;
    }
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(folder);
    });
    watchers.set(folder, watcher);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch {}
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) add(full, depth + 1, reportExisting);
      } else if (reportExisting) {
        onCreated(path.relative(root, full));
      }
    }
  };
  add(root, 0, false);
  return () => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
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
  const stops = (["codex", "claude"] as const).flatMap((backend) => {
    const folder = folders[backend];
    const onCreated = (relativePath: string): void => {
      if (isNativeSessionTranscript(backend, relativePath)) notify();
    };
    try {
      if (process.platform === "linux") return [watchFolderTree(folder, TRANSCRIPT_DEPTH[backend], onCreated)];
      // macOS and Windows watch a tree natively with one handle.
      // "rename" covers creation; plain appends arrive as "change".
      const watcher = fs.watch(folder, { recursive: true, persistent: false }, (event, filename) => {
        if (event === "rename" && filename) onCreated(filename);
      });
      watcher.on("error", (error) => console.warn(`[NativeSessions] stopped watching ${folder}: ${errorMessage(error)}`));
      return [() => watcher.close()];
    } catch (error) {
      // A backend that was never used has no folder yet; its sessions still
      // appear when the list cache expires.
      console.warn(`[NativeSessions] not watching ${folder}: ${errorMessage(error)}`);
      return [];
    }
  });
  return () => {
    for (const stop of stops) stop();
    if (timer) clearTimeout(timer);
  };
}
