import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

const ACCESS_CHECK_TIMEOUT_MS = 4_000;

export interface MacosFileAccessStatus {
  supported: boolean;
  platform: NodeJS.Platform;
  access: "granted" | "denied" | "unknown" | "not_applicable";
  path: string;
  helperInstalled: boolean;
  helperActive: boolean;
  helperPath: string;
  settingsPane: string;
  error?: string;
  errorCode?: "macos_privacy_denied";
}

export function macosHelperAppPath(): string {
  return process.env.SOCKETAGENT_MACOS_HELPER_APP
    || path.join(os.homedir(), "Applications", "SocketAgent Server.app");
}

export function macosPermissionSettingsPane(): string {
  return "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
}

function protectedRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Downloads"),
    path.join(home, "Library", "Mobile Documents"),
  ];
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isMacosProtectedUserPath(filePath: string): boolean {
  if (process.platform !== "darwin") return false;
  const resolved = path.resolve(filePath);
  return protectedRoots().some((root) => isInside(resolved, root));
}

export function macosPrivacyErrorDetails(
  filePath: string,
  error: unknown,
): Partial<MacosFileAccessStatus> | null {
  if (!isMacosProtectedUserPath(filePath)) return null;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== "EPERM" && code !== "EACCES" && !/timed out/i.test(message)) return null;
  const helperPath = macosHelperAppPath();
  return {
    access: "denied",
    path: path.resolve(filePath),
    helperInstalled: fs.existsSync(helperPath),
    helperActive: process.env.SOCKETAGENT_MACOS_HELPER === "1",
    helperPath,
    settingsPane: macosPermissionSettingsPane(),
    error: message,
    errorCode: "macos_privacy_denied",
  };
}

function readdirWithTimeout(dirPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const probe = [
      "const fs=require('fs');",
      "fs.readdir(process.argv[1],(error)=>{",
      "if(error){console.error(error.code||error.message);process.exit(2);}",
      "process.exit(0);",
      "});",
    ].join("");
    execFile(
      process.execPath,
      ["-e", probe, dirPath],
      { timeout: ACCESS_CHECK_TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = stderr.trim();
        if (error.killed || (error as any).code === "ETIMEDOUT") {
          reject(new Error(`Access check timed out after ${ACCESS_CHECK_TIMEOUT_MS / 1000} seconds`));
          return;
        }
        const denied = new Error(detail || error.message) as NodeJS.ErrnoException;
        if (detail === "EPERM" || detail === "EACCES") denied.code = detail;
        reject(denied);
      },
    );
  });
}

export async function checkMacosFileAccess(targetPath?: string): Promise<MacosFileAccessStatus> {
  const helperPath = macosHelperAppPath();
  const base = targetPath?.trim() || path.join(os.homedir(), "Documents");
  const status: MacosFileAccessStatus = {
    supported: process.platform === "darwin",
    platform: process.platform,
    access: process.platform === "darwin" ? "unknown" : "not_applicable",
    path: path.resolve(base),
    helperInstalled: fs.existsSync(helperPath),
    helperActive: process.env.SOCKETAGENT_MACOS_HELPER === "1",
    helperPath,
    settingsPane: macosPermissionSettingsPane(),
  };
  if (process.platform !== "darwin") return status;

  try {
    await readdirWithTimeout(status.path);
    status.access = "granted";
  } catch (error) {
    status.access = "denied";
    status.error = error instanceof Error ? error.message : String(error);
    status.errorCode = "macos_privacy_denied";
  }
  return status;
}

function runOpen(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile("open", args, { timeout: 10_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function performMacosPermissionAction(
  action: "open_settings" | "reveal_helper",
): Promise<{ ok: boolean; action: string; helperPath: string; error?: string }> {
  const helperPath = macosHelperAppPath();
  if (process.platform !== "darwin") {
    return { ok: false, action, helperPath, error: "This action is only available on macOS" };
  }
  try {
    if (action === "open_settings") {
      await runOpen([macosPermissionSettingsPane()]);
    } else {
      if (!fs.existsSync(helperPath)) throw new Error("SocketAgent Server.app is not installed");
      await runOpen(["-R", helperPath]);
    }
    return { ok: true, action, helperPath };
  } catch (error) {
    return {
      ok: false,
      action,
      helperPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
