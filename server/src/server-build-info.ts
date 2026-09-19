import { execFileSync } from "child_process";
import * as path from "path";

import packageJson from "../package.json";

const FALLBACK_SERVER_VERSION = "0.0.0";

/** Commits on a ref, or null when git cannot answer (tarball install, no repo). */
function commitCount(ref: string): string | null {
  try {
    const count = execFileSync("git", ["rev-list", "--count", ref], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    return /^\d+$/.test(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * Builds a release version whose patch number is the commit count on `ref`.
 *
 * Major and minor stay hand-set in package.json to mark real releases. The
 * patch is derived so that no one has to remember to move it: the number is
 * read off a list of many connected machines to tell at a glance which ones
 * have updated, and a version bumped by hand is stale exactly when it matters.
 *
 * The count covers every commit, not just those touching server/, because
 * auto-update pulls the whole repository. Two machines on different commits
 * must never show the same version, and the difference between two versions
 * is then the number of commits one is behind.
 */
export function serverReleaseVersionFor(ref: string, declared: unknown): string {
  const base = typeof declared === "string" && declared.trim()
    ? declared.trim()
    : FALLBACK_SERVER_VERSION;
  const [major, minor] = base.split(".");
  const count = commitCount(ref);
  // Without git there is nothing better than the version as committed.
  if (!count || !major || !minor) return base;
  return `${major}.${minor}.${count}`;
}

/**
 * Human-readable SocketAgent server release version.
 *
 * This is intentionally separate from the git commit: the release version is
 * easy to compare in the app, while the commit identifies the exact running
 * code when diagnosing a stale process or mixed deployments.
 */
export const SERVER_RELEASE_VERSION = serverReleaseVersionFor("HEAD", packageJson.version);
