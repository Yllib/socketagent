import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as pty from "node-pty";

const OPEN_READY_STATE = 1;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MAX_COLS = 300;
const MAX_ROWS = 120;
const MAX_SCROLLBACK_CHARS = 256 * 1024;

export interface TerminalTransport {
  readonly readyState: number;
  send(data: string): void;
}

type TerminalSpawnOptions = {
  cwd: string;
  cols?: number;
  rows?: number;
};

function clampDimension(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(10, Math.min(max, Math.floor(parsed)));
}

function shellForPlatform(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }
  return process.env.SHELL || (fs.existsSync("/bin/bash") ? "/bin/bash" : "sh");
}

function ensureDirectory(candidate: string | undefined): string {
  const fallbacks = [
    candidate,
    process.env.HOME,
    os.homedir(),
    process.cwd(),
    process.platform === "win32" ? process.env.SystemDrive || "C:\\" : "/tmp",
  ];
  for (const raw of fallbacks) {
    if (!raw) continue;
    const resolved = path.resolve(raw);
    try {
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Try the next fallback.
    }
  }
  return process.cwd();
}

function writeJson(transport: TerminalTransport, payload: Record<string, unknown>): void {
  if (transport.readyState !== OPEN_READY_STATE) return;
  transport.send(JSON.stringify(payload));
}

class TerminalSessionManager {
  private process: pty.IPty | null = null;
  private subscribers = new Set<TerminalTransport>();
  private scrollback = "";
  private cwd = "";
  private shell = "";
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;

  get running(): boolean {
    return this.process !== null;
  }

  attach(transport: TerminalTransport, options: TerminalSpawnOptions): void {
    this.subscribers.add(transport);
    if (!this.process) {
      this.spawn(options);
    } else {
      const nextCols = clampDimension(options.cols, this.cols, MAX_COLS);
      const nextRows = clampDimension(options.rows, this.rows, MAX_ROWS);
      if (nextCols !== this.cols || nextRows !== this.rows) {
        this.resize(nextCols, nextRows);
      }
    }

    writeJson(transport, this.statusPayload());
    if (this.scrollback) {
      writeJson(transport, {
        type: "terminal_output",
        data: this.scrollback,
        replay: true,
      });
    }
  }

  detach(transport: TerminalTransport): void {
    this.subscribers.delete(transport);
  }

  input(data: unknown): void {
    if (!this.process || typeof data !== "string" || data.length === 0) return;
    this.process.write(data);
  }

  resize(cols: unknown, rows: unknown): void {
    const nextCols = clampDimension(cols, this.cols, MAX_COLS);
    const nextRows = clampDimension(rows, this.rows, MAX_ROWS);
    this.cols = nextCols;
    this.rows = nextRows;
    try {
      this.process?.resize(nextCols, nextRows);
    } catch (err: any) {
      this.broadcast({
        type: "terminal_error",
        message: `Failed to resize terminal: ${err?.message || String(err)}`,
      });
    }
  }

  kill(): void {
    if (!this.process) return;
    try {
      this.process.kill();
    } catch (err: any) {
      this.broadcast({
        type: "terminal_error",
        message: `Failed to stop terminal: ${err?.message || String(err)}`,
      });
    }
  }

  private spawn(options: TerminalSpawnOptions): void {
    this.cwd = ensureDirectory(options.cwd);
    this.shell = shellForPlatform();
    this.cols = clampDimension(options.cols, DEFAULT_COLS, MAX_COLS);
    this.rows = clampDimension(options.rows, DEFAULT_ROWS, MAX_ROWS);
    this.scrollback = "";

    try {
      this.process = pty.spawn(this.shell, [], {
        name: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: process.env.COLORTERM || "truecolor",
          SOCKETAGENT_TERMINAL: "1",
        },
      });
    } catch (err: any) {
      this.process = null;
      this.broadcast({
        type: "terminal_error",
        message: `Failed to start terminal: ${err?.message || String(err)}`,
      });
      return;
    }

    this.process.onData((data) => {
      this.appendScrollback(data);
      this.broadcast({ type: "terminal_output", data });
    });

    this.process.onExit(({ exitCode, signal }) => {
      this.process = null;
      this.broadcast({
        type: "terminal_exited",
        exitCode,
        ...(signal ? { signal } : {}),
      });
      this.broadcast(this.statusPayload(exitCode));
    });
  }

  private appendScrollback(data: string): void {
    this.scrollback += data;
    if (this.scrollback.length > MAX_SCROLLBACK_CHARS) {
      this.scrollback = this.scrollback.slice(this.scrollback.length - MAX_SCROLLBACK_CHARS);
    }
  }

  private statusPayload(exitCode?: number): Record<string, unknown> {
    return {
      type: "terminal_status",
      running: this.process !== null,
      pid: this.process?.pid,
      cwd: this.cwd,
      shell: this.shell,
      cols: this.cols,
      rows: this.rows,
      ...(typeof exitCode === "number" ? { exitCode } : {}),
    };
  }

  private broadcast(payload: Record<string, unknown>): void {
    const encoded = JSON.stringify(payload);
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.readyState === OPEN_READY_STATE) {
        subscriber.send(encoded);
      } else {
        this.subscribers.delete(subscriber);
      }
    }
  }
}

export const terminalSessionManager = new TerminalSessionManager();
