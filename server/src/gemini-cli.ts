/**
 * Google's Antigravity CLI (`agy`), the program SocketAgent drives for Gemini.
 *
 * SocketAgent installs its own copy under the SocketAgent home so it never
 * edits the user's shell profile, and falls back to one the user installed.
 * agy updates itself in the background while it runs, so there is no update
 * job here. Sign-in belongs to agy too: `agy acp --login` prints a Google
 * link, and the code from the page Google lands on goes back on its stdin.
 */

import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { killProcessTree, runProbe } from "./async-probe";
import { socketAgentHome } from "./socket-agent-paths";

// Google's release server, from https://antigravity.google/cli/install.sh.
const RELEASE_BASE_URL = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
const FIRST_START_TIMEOUT_MS = 120_000;

const manifestSchema = z.object({ version: z.string(), url: z.string().url(), sha512: z.string().regex(/^[0-9a-f]{128}$/i) });

function binaryName(): string {
  return process.platform === "win32" ? "agy.exe" : "agy";
}

/** Where SocketAgent keeps its own agy. agy rewrites this file when it updates itself. */
export function managedAgyDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(socketAgentHome(env), "toolchains", "agy");
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** The agy to run: SocketAgent's copy, then the one Google's installer puts in place, then PATH. */
export function resolveAgyCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(managedAgyDir(env), binaryName()),
    process.platform === "win32"
      ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "agy", "bin", "agy.exe")
      : path.join(home, ".local", "bin", "agy"),
  ];
  for (const candidate of candidates) if (isFile(candidate)) return candidate;
  const pathValue = env.PATH || env.Path || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binaryName());
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function releasePlatform(): string {
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  if (!arch) throw new Error(`The Antigravity CLI has no build for ${process.arch} processors.`);
  if (process.platform === "win32") return `windows_${arch}`;
  if (process.platform === "darwin") return `darwin_${arch}`;
  if (process.platform === "linux") {
    const musl = fs.existsSync(`/lib/libc.musl-${process.arch === "x64" ? "x86_64" : "aarch64"}.so.1`);
    return `linux_${arch}${musl ? "_musl" : ""}`;
  }
  throw new Error(`The Antigravity CLI does not run on ${process.platform}.`);
}

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

async function download(url: string, signal?: AbortSignal): Promise<Buffer> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** `agy --version`, or null when it does not run. */
export async function agyVersion(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const result = await runProbe(command, ["--version"], { env, timeoutMs: FIRST_START_TIMEOUT_MS });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/**
 * Downloads the latest agy from Google's release server, checks it against
 * the SHA-512 in Google's manifest, and replaces SocketAgent's copy only once
 * the new one runs. Returns the installed version.
 */
export async function installAgy(options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; onProgress: (message: string) => void }): Promise<string> {
  const env = options.env ?? process.env;
  const platform = releasePlatform();
  options.onProgress("Checking Google's latest Antigravity CLI...");
  const manifest = manifestSchema.parse(JSON.parse((await download(`${RELEASE_BASE_URL}/manifests/${platform}.json`, options.signal)).toString("utf8")));
  const payloadUrl = new URL(manifest.url);
  if (payloadUrl.protocol !== "https:" || payloadUrl.hostname !== "storage.googleapis.com") {
    throw new Error("Google's release manifest points somewhere unexpected. Nothing was installed.");
  }
  options.onProgress(`Downloading Antigravity CLI ${manifest.version}...`);
  const payload = await download(manifest.url, options.signal);
  const actual = crypto.createHash("sha512").update(payload).digest("hex");
  if (actual !== manifest.sha512.toLowerCase()) {
    throw new Error("The downloaded Antigravity CLI does not match Google's checksum. Nothing was installed.");
  }

  const dir = managedAgyDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dir, ".staging-"));
  try {
    const staged = path.join(staging, binaryName());
    if (payloadUrl.pathname.endsWith(".tar.gz")) {
      const archive = path.join(staging, "agy.tar.gz");
      fs.writeFileSync(archive, payload);
      const untar = await runProbe("tar", ["-xzf", archive, "-C", staging, "antigravity"], { timeoutMs: 120_000 });
      if (untar.status !== 0) throw new Error(`Could not unpack the Antigravity CLI: ${untar.stderr.trim() || "tar failed"}`);
      fs.renameSync(path.join(staging, "antigravity"), staged);
    } else {
      fs.writeFileSync(staged, payload);
    }
    fs.chmodSync(staged, 0o755);
    options.onProgress("Checking the new Antigravity CLI runs...");
    const version = await agyVersion(staged, env);
    if (!version) throw new Error("The new Antigravity CLI did not start. The existing install was kept.");
    fs.renameSync(staged, path.join(dir, binaryName()));
    return version;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** One `agy acp --login` waiting for the code from Google's landing page. */
export interface AgyLogin {
  authUrl: string;
  /** Writes the pasted code, or the landing page's full URL, to agy and waits for it to finish. */
  submitCode(code: string): Promise<void>;
  cancel(): void;
  /** Settles when agy exits: resolves on a saved sign-in, rejects otherwise. */
  done: Promise<void>;
}

/** Only Google's own sign-in page, never a link from anywhere else. */
function isGoogleSignInUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

/**
 * Starts agy's terminal sign-in and resolves once it prints Google's link.
 * The code a user pastes is sent to agy and nowhere else; it is never logged.
 */
export function startAgyLogin(command: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<AgyLogin> {
  return new Promise((resolveLogin, rejectLogin) => {
    const child = spawn(command, ["acp", "--login"], {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let announced = false;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    const timer = setTimeout(() => killProcessTree(child), options.timeoutMs ?? 15 * 60_000);
    const onOutput = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_000);
      if (announced) return;
      // Only a link followed by whitespace is complete; a chunk can end mid-URL.
      const url = [...output.matchAll(/(https:\/\/\S+)\s/g)].map((match) => match[1]).find(isGoogleSignInUrl);
      if (!url) return;
      announced = true;
      resolveLogin({
        authUrl: url,
        submitCode: async (code) => {
          const trimmed = code.trim();
          if (!trimmed || /[\r\n]/.test(trimmed)) throw new Error("Paste the code from Google's page.");
          child.stdin.write(`${trimmed}\n`);
          await done;
        },
        cancel: () => killProcessTree(child),
        done,
      });
    };
    child.stdin.on("error", () => {});
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectDone(error);
      if (!announced) rejectLogin(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // agy's own words say why, minus the link, which carries a PKCE challenge.
      const reason = output.replace(/https:\/\/\S+/g, "").split("\n").map((line) => line.trim()).filter(Boolean).pop();
      const error = new Error(reason || `Antigravity sign-in ended (exit ${code ?? "unknown"}).`);
      if (code === 0) resolveDone();
      else rejectDone(error);
      if (!announced) rejectLogin(error);
    });
  });
}

const AGY_MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type AgyModelEffort = (typeof AGY_MODEL_EFFORTS)[number];
const MODELS_PROBE_TIMEOUT_MS = 30_000;
let inFlightModelDiscovery: Promise<Array<Record<string, unknown>>> | null = null;

function isAgyEffort(value: string): value is AgyModelEffort {
  return (AGY_MODEL_EFFORTS as readonly string[]).includes(value);
}

/**
 * Parses `agy models` stdout into SocketAgent's model catalog format.
 * Variants that share a base ID with two or more effort suffixes (such as
 * `gemini-4-neon-high` and `gemini-4-neon-low`) collapse into one model family
 * with `supportedReasoningEfforts`, matching `agy acp` session configOptions.
 * Singletons (such as `gpt-oss-120b-medium`) remain standalone.
 */
export function parseAgyModelsOutput(stdout: string): Array<Record<string, unknown>> {
  const rows: Array<{ id: string; label: string; candidateFamily: string | null; effort: AgyModelEffort | null }> = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)\s+(.+)$/i);
    if (!match) continue;
    const [, id, label] = match;
    const dash = id.lastIndexOf("-");
    const suffix = dash > 0 ? id.slice(dash + 1) : "";
    const effort = isAgyEffort(suffix) ? suffix : null;
    rows.push({
      id,
      label: label.trim(),
      candidateFamily: effort ? id.slice(0, dash) : null,
      effort,
    });
  }
  if (rows.length === 0) return [];

  const familyCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.candidateFamily) familyCounts.set(row.candidateFamily, (familyCounts.get(row.candidateFamily) ?? 0) + 1);
  }

  const orderedIds: string[] = [];
  const entries = new Map<string, { displayName: string; efforts: AgyModelEffort[] }>();
  for (const row of rows) {
    const grouped = row.candidateFamily !== null && (familyCounts.get(row.candidateFamily) ?? 0) >= 2;
    const key = grouped ? row.candidateFamily! : row.id;
    let entry = entries.get(key);
    if (!entry) {
      orderedIds.push(key);
      const displayName = grouped
        ? row.label.replace(/\s+\((?:low|medium|high|xhigh|max)\)$/i, "").trim() || row.label
        : row.label;
      entry = { displayName, efforts: [] };
      entries.set(key, entry);
    }
    if (grouped && row.effort && !entry.efforts.includes(row.effort)) {
      entry.efforts.push(row.effort);
    }
  }

  return orderedIds.map((id, index) => {
    const entry = entries.get(id)!;
    const efforts = entry.efforts;
    return {
      id,
      value: id,
      displayName: entry.displayName,
      description: "",
      isDefault: index === 0,
      ...(efforts.length > 0
        ? {
            supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
            supportedEffortLevels: [...efforts],
            defaultReasoningEffort: efforts.includes("high") ? "high" : efforts[efforts.length - 1],
          }
        : {}),
    };
  });
}

/** Runs `agy models` to discover available models before a turn has started. */
export async function discoverAgyModels(
  options: { command?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const run = async (): Promise<Array<Record<string, unknown>>> => {
    const command = options.command ?? resolveAgyCommand(options.env);
    if (!command) return [];
    const result = await runProbe(command, ["models"], {
      env: options.env ?? process.env,
      timeoutMs: options.timeoutMs ?? MODELS_PROBE_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      const detail = result.error?.message || result.stderr.trim() || (result.timedOut ? "timed out" : `exit ${result.status ?? "unknown"}`);
      throw new Error(`agy models failed: ${detail}`);
    }
    return parseAgyModelsOutput(result.stdout);
  };

  if (options.command || options.env || options.timeoutMs !== undefined) return run();
  if (!inFlightModelDiscovery) {
    inFlightModelDiscovery = run().finally(() => { inFlightModelDiscovery = null; });
  }
  return inFlightModelDiscovery;
}
