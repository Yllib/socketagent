import { spawnSync, SpawnSyncReturns } from "child_process";

export interface CodexLinuxSandboxHealth {
  available: boolean;
  reason?: string;
  detail?: string;
}

type BubblewrapProbe = Pick<SpawnSyncReturns<string>, "status" | "error" | "stdout" | "stderr">;

const BUBBLEWRAP_PROBE_ARGS = [
  "--ro-bind", "/", "/",
  "--proc", "/proc",
  "--dev", "/dev",
  "--unshare-all",
  "--die-with-parent",
  "--", "true",
];

function firstProbeLine(probe: BubblewrapProbe): string | undefined {
  const text = `${probe.stderr || ""}\n${probe.stdout || ""}`.trim();
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

export function classifyBubblewrapProbe(
  platform: NodeJS.Platform,
  probe: BubblewrapProbe,
): CodexLinuxSandboxHealth | null {
  if (platform !== "linux") return null;

  const errorCode = (probe.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOENT") {
    return {
      available: false,
      reason: "Bubblewrap (bwrap) is missing, so restricted Codex sandbox modes may fail. SocketAgent will attempt automatic repair; if this persists, install the distribution package named 'bubblewrap'.",
    };
  }

  if (probe.error || probe.status !== 0) {
    return {
      available: false,
      reason: "Bubblewrap is installed but cannot create the Linux sandbox Codex requires. SocketAgent will attempt automatic repair; WSL1 is unsupported and restricted containers may need user-namespace support.",
      detail: probe.error?.message || firstProbeLine(probe) || `bwrap probe exited ${probe.status ?? "without a status"}`,
    };
  }

  return { available: true };
}

export function getCodexLinuxSandboxHealth(
  platform: NodeJS.Platform = process.platform,
): CodexLinuxSandboxHealth | null {
  if (platform !== "linux") return null;
  const probe = spawnSync("bwrap", BUBBLEWRAP_PROBE_ARGS, {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return classifyBubblewrapProbe(platform, probe);
}
