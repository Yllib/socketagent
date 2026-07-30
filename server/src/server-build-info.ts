import packageJson from "../package.json";

const FALLBACK_SERVER_VERSION = "0.0.0";

/**
 * Human-readable SocketAgent server release version.
 *
 * This is intentionally separate from the git commit: the release version is
 * easy to compare in the app, while the commit identifies the exact running
 * code when diagnosing a stale process or mixed deployments.
 */
export const SERVER_RELEASE_VERSION =
  typeof packageJson.version === "string" && packageJson.version.trim()
    ? packageJson.version.trim()
    : FALLBACK_SERVER_VERSION;
