import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileTransferVersion } from "./file-transfer-wire";

const pending = new Map<string, Promise<string>>();

/** Streamed tar output cannot resume. Materialize one immutable archive per
 * directory revision, shared by retries and simultaneous download requests. */
export async function modelDownloadArchive(directory: string, cacheDir: string): Promise<string> {
  const hash = createHash("sha256").update(directory);
  async function scan(dir: string): Promise<void> {
    for (const entry of (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(dir, entry.name);
      hash.update(target).update(fileTransferVersion(await fs.promises.lstat(target)));
      if (entry.isDirectory()) await scan(target);
    }
  }
  await scan(directory);
  const target = path.join(cacheDir, `${hash.digest("hex")}.tar.gz`);
  if (fs.existsSync(target)) return target;
  const existing = pending.get(target);
  if (existing) return existing;
  const job = (async () => {
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await promisify(execFile)("tar", ["czf", temporary, "-C", path.dirname(directory), path.basename(directory)], { windowsHide: true });
      await fs.promises.rename(temporary, target);
      return target;
    } finally { await fs.promises.rm(temporary, { force: true }); }
  })();
  pending.set(target, job);
  try { return await job; } finally { pending.delete(target); }
}
