import { errorMessage, errorCode } from "./value-guards";
import * as fs from "fs";
import * as path from "path";

const MIN_FREE_BYTES = 1024 ** 3;

async function requireSpace(directory: string, minimum: number): Promise<void> {
  const stat = await fs.promises.statfs(directory);
  const available = stat.bavail * stat.bsize;
  if (available < minimum) {
    throw new Error(`Not enough free space to repair agent software: ${(available / 1024 ** 3).toFixed(1)} GiB available, ${(minimum / 1024 ** 3).toFixed(0)} GiB required. The installed software was not changed.`);
  }
}

/** Build and probe a replacement outside the live prefix. Failed downloads,
 * npm leftovers, cancellation, and failed probes cannot damage the live install.
 * Auth and sessions live outside this prefix and are never copied or removed. */
export async function installManagedBackendSafely(options: {
  prefix: string;
  packageName: string;
  signal?: AbortSignal;
  installAndVerify: (prefix: string, cache: string) => Promise<void>;
}): Promise<void> {
  const prefix = path.resolve(options.prefix);
  const parent = path.dirname(prefix);
  await fs.promises.mkdir(parent, { recursive: true });
  const lock = `${prefix}.install-lock`;
  // The file lock also excludes repairs launched by a second server/process.
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const owner = Number(fs.readFileSync(lock, "utf8"));
    let alive = true;
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); } catch (probeError) {
        alive = errorCode(probeError) !== "ESRCH";
      }
    }
    if (alive) throw new Error("Another backend install is running. Try again when it finishes.");
    fs.unlinkSync(lock);
    fd = fs.openSync(lock, "wx", 0o600);
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
    throw error;
  }
  fs.closeSync(fd);
  const backup = `${prefix}.previous`;
  let work: string | undefined;
  try {
    // Recover an interrupted promotion before making another candidate.
    if (!fs.existsSync(prefix) && fs.existsSync(backup)) fs.renameSync(backup, prefix);
    options.signal?.throwIfAborted();
    const workPrefix = `.${path.basename(prefix)}-install-`;
    for (const entry of await fs.promises.readdir(parent)) {
      if (entry.startsWith(workPrefix)) {
        await fs.promises.rm(path.join(parent, entry), { recursive: true, force: true });
      }
    }
    await requireSpace(parent, 2 * MIN_FREE_BYTES);
    work = await fs.promises.mkdtemp(path.join(parent, workPrefix));
    const candidate = path.join(work, "prefix");
    const modules = process.platform === "win32" ? "node_modules" : path.join("lib", "node_modules");
    const packageParts = options.packageName.split("/");
    const scope = packageParts.length === 2 ? packageParts[0] : "";
    const name = packageParts.at(-1)!;
    if (fs.existsSync(prefix)) {
      await fs.promises.cp(prefix, candidate, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (source) => {
          const relative = path.relative(prefix, source);
          if (relative === path.join(modules, ".package-lock.json")) return false;
          if (path.dirname(relative) === path.join(modules, scope)) {
            const leaf = path.basename(relative);
            // Force a fresh selected package and its platform binaries. Skip
            // abandoned npm rename targets rather than copying their corruption.
            if (leaf === name || leaf.startsWith(`${name}-`) || leaf.startsWith(`.${name}-`)) return false;
          }
          return true;
        },
      });
    } else {
      await fs.promises.mkdir(candidate, { recursive: true });
    }
    // Remove the selected old shims; npm will recreate them for the candidate.
    const bin = process.platform === "win32" ? candidate : path.join(candidate, "bin");
    const command = name === "claude-code" ? "claude" : name;
    for (const suffix of ["", ".cmd", ".ps1", ".exe"]) {
      await fs.promises.rm(path.join(bin, `${command}${suffix}`), { force: true });
    }
    await requireSpace(parent, MIN_FREE_BYTES);
    options.signal?.throwIfAborted();
    await options.installAndVerify(candidate, path.join(work, "cache"));
    options.signal?.throwIfAborted();
    await fs.promises.rm(backup, { recursive: true, force: true });
    const hadPrevious = fs.existsSync(prefix);
    if (hadPrevious) fs.renameSync(prefix, backup);
    try {
      fs.renameSync(candidate, prefix);
    } catch (error) {
      if (hadPrevious) fs.renameSync(backup, prefix);
      throw error;
    }
    await fs.promises.rm(backup, { recursive: true, force: true }).catch((error: Error) => {
      console.warn(`[Backend install] Could not remove previous software: ${errorMessage(error)}`);
    });
  } finally {
    try {
      if (work) await fs.promises.rm(work, { recursive: true, force: true });
    } finally {
      fs.unlinkSync(lock);
    }
  }
}
