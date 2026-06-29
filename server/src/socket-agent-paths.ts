import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SOCKET_AGENT_DIR_NAME = ".socket-agent";
const LEGACY_DIR_NAME = ".claude-assistant";

let dataDirMigrationChecked = false;

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim()) return value;
  }
  return undefined;
}

export function socketAgentHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || os.homedir();
  return envValue(env, "SOCKET_AGENT_HOME", "SOCKETAGENT_HOME")
    || path.join(home, SOCKET_AGENT_DIR_NAME);
}

export function legacySocketAgentHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || os.homedir();
  return path.join(home, LEGACY_DIR_NAME);
}

export function socketAgentDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return envValue(env, "SOCKET_AGENT_DATA_DIR", "SOCKETAGENT_DATA_DIR")
    || socketAgentHome(env);
}

export function managedNpmPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return envValue(env, "SOCKET_AGENT_NPM_PREFIX", "SOCKETAGENT_NPM_PREFIX")
    || path.join(socketAgentHome(env), "toolchains", "npm-global");
}

export function managedNpmBinDir(env: NodeJS.ProcessEnv = process.env): string {
  const prefix = managedNpmPrefix(env);
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

export function legacyManagedNpmPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || os.homedir();
  return path.join(home, ".local", "share", "socketagent", "npm-global");
}

export function legacyManagedNpmBinDir(env: NodeJS.ProcessEnv = process.env): string {
  const prefix = legacyManagedNpmPrefix(env);
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

function ensureLegacyAlias(legacyDir: string, targetDir: string): void {
  try {
    if (fs.existsSync(legacyDir)) return;
    fs.symlinkSync(targetDir, legacyDir, process.platform === "win32" ? "junction" : "dir");
  } catch (err: any) {
    console.warn(`[paths] Could not create legacy ${LEGACY_DIR_NAME} alias: ${err?.message || String(err)}`);
  }
}

function sameRealPath(left: string, right: string): boolean {
  try {
    if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

export function ensureSocketAgentDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = socketAgentDataDir(env);
  const legacyDir = legacySocketAgentHome(env);

  if (!dataDirMigrationChecked) {
    dataDirMigrationChecked = true;
    if (path.resolve(dataDir) !== path.resolve(legacyDir)
      && fs.existsSync(legacyDir)
      && !sameRealPath(dataDir, legacyDir)) {
      if (!fs.existsSync(dataDir)) {
        try {
          fs.renameSync(legacyDir, dataDir);
          ensureLegacyAlias(legacyDir, dataDir);
          console.log(`[paths] Migrated SocketAgent data from ${legacyDir} to ${dataDir}`);
        } catch (err: any) {
          console.warn(`[paths] Could not move ${legacyDir} to ${dataDir}: ${err?.message || String(err)}`);
          try {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.cpSync(legacyDir, dataDir, { recursive: true, force: false, errorOnExist: false });
            console.log(`[paths] Copied legacy SocketAgent data from ${legacyDir} to ${dataDir}`);
          } catch (copyErr: any) {
            console.warn(`[paths] Could not copy legacy SocketAgent data: ${copyErr?.message || String(copyErr)}`);
          }
        }
      } else {
        try {
          fs.cpSync(legacyDir, dataDir, { recursive: true, force: false, errorOnExist: false });
          console.log(`[paths] Merged legacy SocketAgent data from ${legacyDir} into ${dataDir}`);
        } catch (copyErr: any) {
          console.warn(`[paths] Could not merge legacy SocketAgent data: ${copyErr?.message || String(copyErr)}`);
        }
      }
    }
  }

  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function socketAgentDataPath(...parts: string[]): string {
  return path.join(ensureSocketAgentDataDir(), ...parts);
}
