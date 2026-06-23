import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
}

function includesPathDir(pathValue: string | undefined, dir: string): boolean {
  if (!pathValue) return false;
  const normalized = path.resolve(dir).toLowerCase();
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry).toLowerCase() === normalized);
}

function codexCandidateDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || os.homedir();
  const dirs: string[] = [];

  if (process.platform === "win32") {
    const appData = env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
    const localAppData = env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
    if (appData) dirs.push(path.join(appData, "npm"));
    if (localAppData) {
      dirs.push(
        path.join(localAppData, "npm"),
        path.join(localAppData, "Programs", "nodejs"),
      );
    }
    if (env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, "nodejs"));
    const programFilesX86 = env["ProgramFiles(x86)"];
    if (programFilesX86) dirs.push(path.join(programFilesX86, "nodejs"));
  } else if (home) {
    dirs.push(
      path.join(home, ".local", "share", "socketagent", "npm-global", "bin"),
      path.join(home, ".local", "bin"),
    );
  }

  return dirs.filter((dir, index, all) =>
    !!dir && all.indexOf(dir) === index && fs.existsSync(dir)
  );
}

export function buildCodexProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const key = pathKey(env);
  let value = env[key] || "";

  for (const dir of codexCandidateDirs(env)) {
    if (!includesPathDir(value, dir)) {
      value = value ? `${value}${path.delimiter}${dir}` : dir;
    }
  }

  env[key] = value;
  if (key !== "PATH") env.PATH = value;
  return env;
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv = buildCodexProcessEnv()): string {
  const explicit = env.CODEX_BIN || env.CODEX_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const key = pathKey(env);
  const pathValue = env[key] || env.PATH || "";
  const names = process.platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
    : ["codex"];

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return "codex";
}

export function buildCodexSpawn(
  args: string[],
  base: NodeJS.ProcessEnv = process.env
): { command: string; args: string[]; env: NodeJS.ProcessEnv; shell: boolean } {
  const env = buildCodexProcessEnv(base);
  const command = resolveCodexCommand(env);
  const shell = process.platform === "win32" && !/\.(?:exe|com)$/i.test(command);
  return { command, args, env, shell };
}
