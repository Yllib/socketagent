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
    if (appData) dirs.push(path.join(appData, "npm"));
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
