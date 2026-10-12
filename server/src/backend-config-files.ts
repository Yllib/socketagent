import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TomlError, parse as parseToml } from "smol-toml";
import type { Backend, BackendConfigFile, BackendConfigFormat } from "./protocol";

/**
 * The config files the app's config manager may read and write. The app only
 * ever names a file by its id; every path is resolved here, so credential
 * files such as auth.json and .credentials.json are never reachable.
 */
interface BackendConfigSpec {
  id: string;
  backend: Backend;
  name: string;
  label: string;
  format: BackendConfigFormat;
}

const SPECS: readonly BackendConfigSpec[] = [
  { id: "codex-config", backend: "codex", name: "config.toml", label: "Settings", format: "toml" },
  { id: "codex-agents", backend: "codex", name: "AGENTS.md", label: "Instructions", format: "markdown" },
  { id: "claude-settings", backend: "claude", name: "settings.json", label: "Settings", format: "json" },
  { id: "claude-md", backend: "claude", name: "CLAUDE.md", label: "Instructions", format: "markdown" },
];

/** Editor limit. Larger files are returned truncated and read-only. */
export const BACKEND_CONFIG_MAX_BYTES = 1024 * 1024;

export interface BackendConfigContent {
  file: BackendConfigFile;
  content: string;
  truncated: boolean;
}

export type BackendConfigWriteOutcome =
  | { ok: true; file: BackendConfigFile }
  | { ok: false; conflict: true; current: BackendConfigContent };

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** Where Codex keeps config.toml and AGENTS.md. */
export function codexHomeDir(): string {
  return process.env.CODEX_HOME?.trim() || path.join(homeDir(), ".codex");
}

/** Where Claude Code keeps settings.json and CLAUDE.md. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir(), ".claude");
}

function specPath(spec: BackendConfigSpec): string {
  const dir = spec.backend === "codex" ? codexHomeDir() : claudeConfigDir();
  return path.resolve(dir, spec.name);
}

function resolveSpec(id: unknown): BackendConfigSpec {
  const spec = typeof id === "string" ? SPECS.find((candidate) => candidate.id === id) : undefined;
  if (!spec) throw new Error("Unknown config file");
  return spec;
}

function versionOf(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function describe(spec: BackendConfigSpec, filePath: string, stat: fs.Stats | undefined, version: string | undefined): BackendConfigFile {
  return {
    id: spec.id,
    backend: spec.backend,
    name: spec.name,
    label: spec.label,
    format: spec.format,
    path: filePath,
    exists: !!stat,
    size: stat?.size,
    modifiedAt: stat?.mtime.toISOString(),
    version,
  };
}

function statFile(filePath: string): fs.Stats | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
    return stat;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function readContent(spec: BackendConfigSpec): BackendConfigContent {
  const filePath = specPath(spec);
  const stat = statFile(filePath);
  if (!stat) return { file: describe(spec, filePath, undefined, undefined), content: "", truncated: false };
  const bytes = fs.readFileSync(filePath);
  const truncated = bytes.length > BACKEND_CONFIG_MAX_BYTES;
  const shown = truncated ? bytes.subarray(0, BACKEND_CONFIG_MAX_BYTES) : bytes;
  return {
    file: describe(spec, filePath, stat, versionOf(bytes)),
    content: shown.toString("utf8"),
    truncated,
  };
}

/** Every allowlisted file with its current state, whether or not it exists. */
export function listBackendConfigFiles(): BackendConfigFile[] {
  return SPECS.map((spec) => {
    const filePath = specPath(spec);
    const stat = statFile(filePath);
    return describe(spec, filePath, stat, stat ? versionOf(fs.readFileSync(filePath)) : undefined);
  });
}

export function readBackendConfigFile(id: unknown): BackendConfigContent {
  return readContent(resolveSpec(id));
}

/** The allowlist id for an absolute path the server already knows, such as the file a Codex warning names. */
export function backendConfigFileIdForPath(filePath: string): string | undefined {
  const resolved = path.resolve(filePath);
  const same = process.platform === "win32"
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b;
  return SPECS.find((spec) => same(specPath(spec), resolved))?.id;
}

/**
 * Rejects content the backend could not load. A syntax error in config.toml
 * stops every Codex session on the computer, so it is caught before the save.
 */
function validateContent(spec: BackendConfigSpec, content: string): void {
  if (spec.format === "toml") {
    try {
      parseToml(content);
    } catch (error: unknown) {
      // smol-toml puts the reason on the first line and the spot in line/column.
      const detail = error instanceof Error ? error.message.split("\n")[0].replace(/^Invalid TOML document: /, "") : String(error);
      const where = error instanceof TomlError ? ` Line ${error.line}, column ${error.column}.` : "";
      throw new Error(`${spec.name} is not valid TOML.${where} ${detail}`);
    }
  } else if (spec.format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${spec.name} is not valid JSON. ${detail}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${spec.name} must contain a JSON object. Use {} for no settings.`);
    }
  }
}

/**
 * Replaces the file only when it still matches the version the editor loaded,
 * so two editors cannot silently overwrite each other. The content is written
 * to a sibling temp file and renamed into place, so a crash or a lost
 * connection never leaves a half-written config behind.
 */
export function writeBackendConfigFile(id: unknown, content: unknown, expectedVersion: unknown): BackendConfigWriteOutcome {
  const spec = resolveSpec(id);
  if (typeof content !== "string") throw new Error("Content must be text");
  if (expectedVersion !== null && typeof expectedVersion !== "string") throw new Error("Expected version must be text or null");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > BACKEND_CONFIG_MAX_BYTES) {
    throw new Error(`${spec.name} is limited to ${BACKEND_CONFIG_MAX_BYTES} bytes`);
  }
  validateContent(spec, content);

  const filePath = specPath(spec);
  const before = statFile(filePath);
  const currentVersion = before ? versionOf(fs.readFileSync(filePath)) : null;
  if (currentVersion !== expectedVersion) {
    return { ok: false, conflict: true, current: readContent(spec) };
  }

  // A symlinked config, as in a dotfiles setup, is saved through to its
  // target so the link survives.
  const target = before ? fs.realpathSync(filePath) : filePath;
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.socketagent-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.writeFileSync(temp, bytes, { mode: before ? before.mode & 0o777 : 0o600 });
    fs.renameSync(temp, target);
  } catch (error: unknown) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  const after = statFile(filePath);
  return { ok: true, file: describe(spec, filePath, after, versionOf(bytes)) };
}
