import { errorCode } from "./value-guards";
import * as fs from "fs";
import * as path from "path";
import { socketAgentDataPath } from "./socket-agent-paths";

const SEND_FILE_DIR = socketAgentDataPath("send-files");

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Preserve the exact bytes advertised by one SendFile invocation.
 *
 * COPYFILE_FICLONE avoids duplicating storage on filesystems with copy-on-write
 * support. The fallback is still a real copy, never a hard link: build tools
 * commonly rewrite output files in place, which would mutate a hard-linked
 * "snapshot" and invalidate an older card.
 */
export async function snapshotSendFile(sourcePath: string, fileId: string): Promise<string> {
  const directory = path.join(SEND_FILE_DIR, safeSegment(fileId));
  const destination = path.join(directory, path.basename(sourcePath));
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    try {
      await fs.promises.copyFile(sourcePath, temporary, fs.constants.COPYFILE_FICLONE);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOTSUP" && errorCode(error) !== "EINVAL" && errorCode(error) !== "EXDEV") {
        throw error;
      }
      await fs.promises.copyFile(sourcePath, temporary);
    }
    await fs.promises.chmod(temporary, 0o600);
    await fs.promises.rename(temporary, destination);
    return destination;
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function isSendFileDeliveryPath(filePath: string): boolean {
  const relative = path.relative(SEND_FILE_DIR, path.resolve(filePath));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function deleteSendFileDelivery(filePath: string | undefined): void {
  if (!filePath || !isSendFileDeliveryPath(filePath)) return;
  const relative = path.relative(SEND_FILE_DIR, path.resolve(filePath));
  const deliveryDirectory = path.join(SEND_FILE_DIR, relative.split(path.sep)[0]);
  fs.rmSync(deliveryDirectory, { recursive: true, force: true });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes SendFile snapshots older than `retentionDays`, judged by when the
 * snapshot was taken. Zero keeps them forever. Returns how many were removed.
 */
export async function pruneSendFiles(retentionDays: number, now = Date.now()): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = now - retentionDays * DAY_MS;
  let names: string[];
  try {
    names = await fs.promises.readdir(SEND_FILE_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const directory = path.join(SEND_FILE_DIR, name);
    try {
      const stat = await fs.promises.stat(directory);
      if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
      await fs.promises.rm(directory, { recursive: true, force: true });
      removed++;
    } catch {
      // Gone already or unreadable; the next pass retries.
    }
  }
  return removed;
}

/** Prunes a minute after startup, then hourly, reading the retention each time. */
export function startSendFilePruning(retentionDays: () => number): void {
  const run = () => {
    void pruneSendFiles(retentionDays()).then((removed) => {
      if (removed > 0) console.log(`[SendFile] Removed ${removed} sent files older than ${retentionDays()} days`);
    });
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60 * 1000).unref();
}
