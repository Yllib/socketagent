import { spawn, type ChildProcess } from "child_process";

export interface ProbeResult {
  /** Exit code, or null when the probe failed to start, was killed, or timed out. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Spawn failure, such as ENOENT. */
  error?: Error;
  timedOut: boolean;
}

/**
 * Ends a child and everything it started. On Windows a probe often runs
 * through cmd.exe or a node shim, and killing only that parent leaves the real
 * CLI running; taskkill /T takes the whole tree.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill("SIGKILL");
}

/**
 * Runs a short command such as `codex --version` without blocking the event
 * loop. It settles at the timeout even when a grandchild still holds the
 * output pipes.
 */
export function runProbe(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; shell?: boolean; timeoutMs: number },
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: Omit<ProbeResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env: options.env,
        shell: options.shell,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ status: null, stdout, stderr, error: error instanceof Error ? error : new Error(String(error)), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      killProcessTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ status: null, timedOut: true });
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish({ status: null, error, timedOut: false }));
    child.on("close", (status) => finish({ status, timedOut: false }));
  });
}

/**
 * Holds the latest result of an async probe so synchronous readers never
 * wait. `peek` returns what is known and starts a refresh when it is stale;
 * `fresh` waits for a result taken after the last invalidation. `onChange`
 * runs when a finished probe differs from the value it replaced.
 */
export class BackgroundProbe<T> {
  private value: T | undefined;
  private checkedAt = 0;
  private generation = 0;
  private valueGeneration = -1;
  private running: { generation: number; promise: Promise<T> } | null = null;

  constructor(
    private readonly probe: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly onChange?: () => void,
  ) {}

  peek(): T | undefined {
    if (!this.isFresh()) void this.refresh().catch(() => {});
    return this.value;
  }

  async fresh(): Promise<T> {
    if (this.isFresh() && this.value !== undefined) return this.value;
    return this.refresh();
  }

  /** The next `fresh` waits for a new probe; `peek` keeps the old value until then. */
  invalidate(): void {
    this.generation++;
  }

  private isFresh(): boolean {
    return this.valueGeneration === this.generation && Date.now() - this.checkedAt < this.ttlMs;
  }

  private refresh(): Promise<T> {
    if (this.running?.generation === this.generation) return this.running.promise;
    const generation = this.generation;
    const promise = this.probe().then((value) => {
      // A newer invalidation keeps its own run; this result still beats nothing.
      if (generation >= this.valueGeneration) {
        const changed = JSON.stringify(value) !== JSON.stringify(this.value);
        this.value = value;
        this.checkedAt = Date.now();
        this.valueGeneration = generation;
        if (changed) this.onChange?.();
      }
      return value;
    }).finally(() => {
      if (this.running?.promise === promise) this.running = null;
    });
    this.running = { generation, promise };
    return promise;
  }
}
