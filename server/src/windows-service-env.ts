import * as fs from "fs";
import * as path from "path";
import { currentProcessIdentity, pinnedServiceEnvironment, windowsServiceState, type WindowsServiceState } from "./windows-service-config";
import { errorMessage } from "./value-guards";

// The server imports this module before anything else. When it runs as an
// account other than the install's owner (SYSTEM from a machine-wide task),
// it points the profile, Codex home and git's safe.directory at the owner's
// install before any other module reads them. Under the owner it changes
// nothing.

const SERVER_DIR = path.resolve(__dirname, "..");

export const serviceState: WindowsServiceState = process.platform === "win32"
  ? windowsServiceState(SERVER_DIR, process.env, currentProcessIdentity())
  : { identity: currentProcessIdentity(), service: false };

if (serviceState.service && serviceState.config) {
  Object.assign(process.env, pinnedServiceEnvironment(serviceState.config, process.env));
  // Codex refuses a CODEX_HOME that does not exist yet.
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) {
    try {
      fs.mkdirSync(codexHome, { recursive: true });
    } catch (error: unknown) {
      console.warn(`[Service] Could not create ${codexHome}: ${errorMessage(error)}`);
    }
  }
}
