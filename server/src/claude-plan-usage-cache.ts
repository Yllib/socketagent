import { z } from "zod";
import * as fs from "fs";
import { socketAgentDataPath } from "./socket-agent-paths";

const usageSnapshot = z.object({
  usage: z.record(z.string(), z.unknown()),
  fetchedAt: z.string(),
});

/** The last Claude plan usage the SDK reported, and when. */
export type ClaudePlanUsageSnapshot = z.infer<typeof usageSnapshot>;

let memory: ClaudePlanUsageSnapshot | null | undefined;

function cacheFile(): string {
  return socketAgentDataPath("claude-plan-usage.json");
}

/**
 * Keeps the newest plan usage so the context dialog can still show it when
 * no Claude process is running to ask. Plan limits belong to the account,
 * so one snapshot serves every session on this computer.
 */
export function rememberClaudePlanUsage(usage: unknown, now = new Date()): void {
  const parsed = usageSnapshot.shape.usage.safeParse(usage);
  if (!parsed.success) return;
  memory = { usage: parsed.data, fetchedAt: now.toISOString() };
  try {
    const file = cacheFile();
    const tempFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(memory), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempFile, file);
  } catch {
    // The in-memory copy still serves this process.
  }
}

export function lastClaudePlanUsage(): ClaudePlanUsageSnapshot | null {
  if (memory !== undefined) return memory;
  try {
    memory = usageSnapshot.parse(JSON.parse(fs.readFileSync(cacheFile(), "utf8")));
  } catch {
    memory = null;
  }
  return memory;
}

export function resetClaudePlanUsageCacheForTests(): void {
  memory = undefined;
}
