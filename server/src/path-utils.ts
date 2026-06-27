import * as os from "os";
import * as path from "path";

export interface ResolvedClientPath {
  inputPath: string;
  expandedPath: string;
  resolvedPath: string;
}

export function getProcessHome(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function expandEnvironmentVariables(input: string): string {
  return input
    .replace(/%([^%]+)%/g, (match, name) => process.env[name] || match)
    .replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
      const name = braced || bare;
      return process.env[name] || match;
    });
}

export function resolveClientPath(rawPath: unknown): ResolvedClientPath {
  const inputPath = typeof rawPath === "string" ? rawPath.trim() : "";
  const home = getProcessHome();
  let expandedPath = expandEnvironmentVariables(inputPath);

  if (expandedPath === "~") {
    expandedPath = home;
  } else if (expandedPath.startsWith("~/") || expandedPath.startsWith("~\\")) {
    expandedPath = path.join(home, expandedPath.slice(2));
  }

  return {
    inputPath,
    expandedPath,
    resolvedPath: expandedPath ? path.resolve(expandedPath) : "",
  };
}
