import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isRecord } from "./value-guards";
import { legacyManagedNpmBinDir, legacyManagedNpmPrefix, managedNpmBinDir, managedNpmPrefix, windowsMachineRoot } from "./socket-agent-paths";

// Finds the Claude Code executable the server runs. Kept apart from
// claude-session so the Windows service probe can use the same resolution
// without loading the Agent SDK.

export type ClaudeExecutableSource = "explicit" | "sdk" | "managed" | "legacy" | "system" | "unresolved";

export interface ClaudeExecutableInfo {
  path?: string;
  source: ClaudeExecutableSource;
  reason?: string;
}

function existingFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    return fs.existsSync(filePath) ? filePath : undefined;
  } catch {
    return undefined;
  }
}

function npmGlobalPackageDir(prefix: string, packageName: string): string {
  const parts = packageName.split("/");
  const nodeModules = process.platform === "win32"
    ? path.join(prefix, "node_modules")
    : path.join(prefix, "lib", "node_modules");
  return path.join(nodeModules, ...parts);
}

function resolveClaudePackageBin(prefix: string): string | undefined {
  const packageDir = npmGlobalPackageDir(prefix, "@anthropic-ai/claude-code");
  const packageJsonPath = path.join(packageDir, "package.json");
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (!isRecord(pkg)) return undefined;
    const bins = isRecord(pkg.bin) ? pkg.bin : {};
    const binValue = typeof pkg.bin === "string" ? pkg.bin : bins.claude || Object.values(bins)[0];
    if (typeof binValue !== "string" || !binValue) return undefined;
    return existingFile(path.resolve(packageDir, binValue));
  } catch {
    return undefined;
  }
}

export function isJavaScriptRuntimeFile(filePath: string): boolean {
  return /\.(?:js|mjs|tsx?|jsx)$/i.test(filePath);
}

function resolveSdkClaudeBinary(): string | undefined {
  // Some SDK installs include both linux-*-musl and glibc optional-dep packages.
  // On glibc hosts, make the binary choice explicit so the SDK cannot pick a musl
  // binary and fail with ENOENT for /lib/ld-musl-*.so.1.
  if (process.platform !== "linux") return undefined;
  const arch = process.arch;
  const report = process.report?.getReport();
  const header = isRecord(report) && isRecord(report.header) ? report.header : {};
  const glibcRuntime = header.glibcVersionRuntime;
  const isGlibc = typeof glibcRuntime === "string" && glibcRuntime.length > 0;
  const glibcPkg = `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`;
  const muslPkg = `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`;
  const preferred = isGlibc ? [glibcPkg, muslPkg] : [muslPkg, glibcPkg];
  for (const pkg of preferred) {
    try { return require.resolve(pkg); } catch {}
  }
  return undefined;
}

function resolveInstalledClaudeCli(): string | undefined {
  const isWindows = process.platform === "win32";
  try {
    const command = isWindows ? "where.exe" : "which";
    const output = execFileSync(command, ["claude"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    });
    const first = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) return first;
  } catch {}

  const home = os.homedir();
  const candidates = isWindows
    ? [
        process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "claude.cmd") : undefined,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "npm", "claude.cmd") : undefined,
        path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
        path.join(home, "AppData", "Local", "Programs", "claude", "claude.exe"),
      ]
    : [
        path.join(home, ".local", "bin", "claude"),
        path.join(home, ".claude", "local", "claude"),
        "/usr/local/bin/claude",
      ];
  return candidates.map(existingFile).find(Boolean);
}

function resolveManagedClaudeCli(): { path?: string; source?: ClaudeExecutableSource } {
  const managedPackageBin = resolveClaudePackageBin(managedNpmPrefix());
  if (managedPackageBin) return { path: managedPackageBin, source: "managed" };

  const names = process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];
  for (const name of names) {
    const managed = existingFile(path.join(managedNpmBinDir(), name));
    if (managed) return { path: managed, source: "managed" };
  }

  // The legacy prefix and PATH sit in the owner's profile, which a machine
  // install, run as SYSTEM, must not execute from.
  if (windowsMachineRoot()) return {};
  const legacyPackageBin = resolveClaudePackageBin(legacyManagedNpmPrefix());
  if (legacyPackageBin) return { path: legacyPackageBin, source: "legacy" };

  for (const name of names) {
    const legacy = existingFile(path.join(legacyManagedNpmBinDir(), name));
    if (legacy) return { path: legacy, source: "legacy" };
  }
  return {};
}

export function resolveClaudeExecutable(): ClaudeExecutableInfo {
  const explicit =
    existingFile(process.env.CLAUDE_CODE_EXECUTABLE) ||
    existingFile(process.env.CLAUDE_CODE_PATH);
  if (explicit) return { path: explicit, source: "explicit" };

  const managed = resolveManagedClaudeCli();
  if (managed.path) return { path: managed.path, source: managed.source || "managed" };

  const sdk = resolveSdkClaudeBinary();
  if (sdk) return { path: sdk, source: "sdk" };

  const installed = windowsMachineRoot() ? undefined : resolveInstalledClaudeCli();
  if (installed) return { path: installed, source: "system" };

  return {
    source: "unresolved",
    reason: "No Claude executable was found in the SDK, SocketAgent toolchain, or PATH",
  };
}
