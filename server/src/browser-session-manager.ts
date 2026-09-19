import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";

type JsonRecord = Record<string, unknown>;

export interface BrowserSessionSummary {
  profile: string;
  label: string;
  running: boolean;
  sessionId?: string;
  url?: string;
  title?: string;
  lastUsedAt?: string;
}

/** A session's identity plus the viewport its viewers must map taps through. */
export interface BrowserViewportState {
  profile: string;
  label: string;
  sessionId?: string;
  url: string;
  width: number;
  height: number;
}

export interface BrowserFrame {
  profile: string;
  imageBase64: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  url: string;
  title: string;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role?: string;
  name: string;
  type?: string;
  value?: string;
  /** Present only on things that can be on or off. */
  checked?: boolean;
  disabled: boolean;
}

export interface BrowserSnapshot {
  profile: string;
  url: string;
  title: string;
  text: string;
  elements: BrowserSnapshotElement[];
}

export type BrowserPhoneInput =
  | { action: "tap"; x: number; y: number }
  | { action: "text"; text: string }
  | { action: "key"; key: string }
  | { action: "scroll"; deltaX?: number; deltaY: number }
  | { action: "navigate"; url: string }
  | { action: "reload" }
  | { action: "back" }
  | { action: "forward" };

interface CdpResponse {
  id?: number;
  method?: string;
  params?: JsonRecord;
  result?: JsonRecord;
  error?: { message?: string };
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/**
 * A live screencast of one profile, running only while a phone is watching it.
 *
 * The phone re-arms `expiresAt` while its viewer is open, so a phone that
 * backgrounds, disconnects, or crashes stops the stream by falling silent
 * rather than by sending anything.
 */
interface BrowserWatch {
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
  stop: () => void;
  /** The newest frame not yet sent, held back by the send interval. */
  pending?: BrowserFrame;
  sendTimer?: NodeJS.Timeout;
  lastSentAt: number;
}

interface RunningBrowserSession {
  profile: string;
  label: string;
  sessionId?: string;
  url: string;
  title: string;
  profileDir: string;
  process: ChildProcess;
  displayProcess?: ChildProcess;
  cdp: CdpClient;
  width: number;
  height: number;
  lastUsedAt: string;
  idleTimer?: NodeJS.Timeout;
  watch?: BrowserWatch;
}

const DEFAULT_WIDTH = 430;
const DEFAULT_HEIGHT = 860;
/**
 * The virtual display, which bounds every viewport the session can take.
 *
 * Started well above the default so a viewer can switch to a desktop layout
 * without relaunching the browser. The emulated viewport, not this, is what
 * pages see and what gets captured.
 */
const DISPLAY_WIDTH = 1920;
const DISPLAY_HEIGHT = 1200;
const IDLE_CLOSE_MS = 2 * 60 * 60_000;
/** How long one watch request keeps the screencast alive without a renewal. */
const WATCH_TTL_MS = 20_000;
/** Floor on the gap between pushed frames, so a busy page cannot flood a phone. */
const FRAME_INTERVAL_MS = 200;

interface BrowserDisplay {
  headless: boolean;
  env: NodeJS.ProcessEnv;
  process?: ChildProcess;
}

function socketAgentDataDir(): string {
  return process.env.SOCKET_AGENT_DATA_DIR
    || process.env.SOCKETAGENT_DATA_DIR
    || path.join(process.env.HOME || os.homedir(), ".socket-agent");
}

export function browserDataDir(browserExecutable = resolveBrowserBinary()): string {
  if (process.platform === "linux"
    && (browserExecutable === "/usr/bin/chromium-browser" || browserExecutable === "/snap/bin/chromium")) {
    return path.join(process.env.HOME || os.homedir(), "snap", "chromium", "common", "socketagent-browser-sessions");
  }
  return path.join(socketAgentDataDir(), "browser-sessions");
}

function managedBrowserPath(): string {
  try {
    return fs.readFileSync(
      path.join(socketAgentDataDir(), "browser-runtime", "executable-path"),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

function restrictDirectory(target: string): void {
  try { fs.chmodSync(target, 0o700); } catch {}
}

/** Chromium can leave control files and singleton links behind after a crash. */
export function removeStaleBrowserControlFile(profileDir: string): void {
  const singletonLock = path.join(profileDir, "SingletonLock");
  try {
    const lockTarget = fs.readlinkSync(singletonLock);
    const pidMatch = /-(\d+)$/.exec(lockTarget);
    if (pidMatch) {
      const pid = Number(pidMatch[1]);
      try {
        process.kill(pid, 0);
        throw new Error(`Browser profile is still owned by process ${pid}.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT"
      && !String((error as Error).message).startsWith("Browser profile is still owned")) {
      throw new Error(`Could not inspect the browser profile lock: ${(error as Error).message}`);
    }
    if (String((error as Error).message).startsWith("Browser profile is still owned")) throw error;
  }

  for (const name of ["DevToolsActivePort", "SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.rmSync(path.join(profileDir, name), { force: true });
    } catch (error) {
      throw new Error(
        `Could not remove stale browser control file ${name}: ${(error as Error).message}`,
      );
    }
  }
}

export function normalizeBrowserProfile(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error("Browser profile names may contain lowercase letters, numbers, underscores, and hyphens.");
  }
  return normalized;
}

export function normalizeBrowserUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Browser URL is invalid."); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("Browser URLs must use HTTP or HTTPS and cannot contain embedded credentials.");
  }
  return url.toString();
}

function browserCandidates(): string[] {
  const configured = process.env.SOCKETAGENT_BROWSER_BINARY?.trim();
  const managed = managedBrowserPath();
  const candidates = configured ? [configured] : [];
  if (managed) candidates.push(managed);
  if (process.platform === "win32") {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/snap/bin/chromium",
    );
  }
  return candidates;
}

export function resolveBrowserBinary(): string {
  const candidate = browserCandidates().find((item) => item && fs.existsSync(item));
  if (!candidate) {
    throw new Error(
      "No supported Chrome, Chromium, or Edge installation was found. Install one or set SOCKETAGENT_BROWSER_BINARY.",
    );
  }
  return candidate;
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function stopChildProcess(processHandle: ChildProcess | undefined): Promise<void> {
  if (!processHandle || processHandle.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      resolve();
    }, 3_000);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    processHandle.kill("SIGTERM");
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Could not reserve a browser control port."));
        else resolve(port);
      });
    });
  });
}

function resolveXvfbBinary(): string {
  const configured = process.env.SOCKETAGENT_XVFB_BINARY?.trim();
  return [configured, "/usr/bin/Xvfb", "/usr/local/bin/Xvfb"]
    .find((candidate): candidate is string => !!candidate && fs.existsSync(candidate)) || "";
}

async function startVirtualDisplay(width: number, height: number): Promise<BrowserDisplay> {
  if (process.platform !== "linux") {
    return { headless: false, env: { ...process.env } };
  }
  if (process.env.DISPLAY) {
    return { headless: false, env: { ...process.env } };
  }

  const xvfbBinary = resolveXvfbBinary();
  if (!xvfbBinary) {
    console.warn("[BrowserSession] Xvfb is unavailable; falling back to headless Chromium.");
    return { headless: true, env: { ...process.env } };
  }

  const displayProcess = spawn(xvfbBinary, [
    "-displayfd", "3",
    "-screen", "0", `${width}x${height}x24`,
    "-nolisten", "tcp",
    "-noreset",
  ], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  const displayPipe = displayProcess.stdio[3];
  if (!displayPipe) {
    displayProcess.kill("SIGTERM");
    throw new Error("Virtual browser display did not expose its display number.");
  }

  const displayNumber = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("Virtual browser display did not start within 5 seconds.")), 5_000);
    const finish = (error?: Error, value?: string): void => {
      clearTimeout(timer);
      displayPipe.removeAllListeners();
      displayProcess.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve(value || "");
    };
    const onExit = (): void => finish(new Error("Virtual browser display exited before startup."));
    displayProcess.once("exit", onExit);
    displayPipe.on("data", (chunk) => {
      output += chunk.toString();
      const line = output.split(/\r?\n/, 1)[0].trim();
      if (/^[0-9]+$/.test(line)) finish(undefined, line);
    });
    displayPipe.once("error", (error) => finish(error));
  }).catch((error) => {
    displayProcess.kill("SIGTERM");
    throw error;
  });

  return {
    headless: false,
    env: { ...process.env, DISPLAY: `:${displayNumber}` },
    process: displayProcess,
  };
}

class CdpClient {
  private socket: WebSocket;
  private nextId = 0;
  private pending = new Map<number, {
    resolve: (value: JsonRecord) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private listeners = new Map<string, Set<(params: JsonRecord) => void>>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => this.onMessage(raw.toString()));
    socket.on("close", () => this.rejectAll(new Error("Browser connection closed.")));
    socket.on("error", (error) => this.rejectAll(error));
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url, { maxPayload: 32 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser connection timed out.")), 15_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new CdpClient(socket);
  }

  async command(method: string, params: JsonRecord = {}): Promise<JsonRecord> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("Browser connection is not open.");
    const id = ++this.nextId;
    return await new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribe to a CDP event. Returns the unsubscribe function. */
  on(method: string, handler: (params: JsonRecord) => void): () => void {
    const handlers = this.listeners.get(method) ?? new Set();
    handlers.add(handler);
    this.listeners.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (!handlers.size) this.listeners.delete(method);
    };
  }

  close(): void {
    try { this.socket.close(); } catch {}
  }

  private onMessage(raw: string): void {
    let message: CdpResponse;
    try { message = JSON.parse(raw) as CdpResponse; }
    catch { return; }
    if (typeof message.id !== "number") {
      // Events carry a method instead of an id.
      if (typeof message.method !== "string") return;
      for (const handler of this.listeners.get(message.method) ?? []) {
        try { handler(message.params ?? {}); } catch {}
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "Browser command failed."));
    else pending.resolve(message.result || {});
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function readStringResult(result: JsonRecord): string {
  const nested = result.result;
  if (!nested || typeof nested !== "object") return "";
  const value = (nested as JsonRecord).value;
  return typeof value === "string" ? value : "";
}

function runtimeExceptionDescription(result: JsonRecord): string {
  const details = result.exceptionDetails;
  if (!details || typeof details !== "object") return "";
  const record = details as JsonRecord;
  const exception = record.exception;
  if (exception && typeof exception === "object") {
    const description = (exception as JsonRecord).description;
    if (typeof description === "string") return description.split("\n", 1)[0].slice(0, 300);
  }
  return typeof record.text === "string" ? record.text.slice(0, 300) : "";
}

function boundedLabel(value: string | undefined, profile: string): string {
  const label = String(value || "").trim().replace(/[\r\n\t]+/g, " ").slice(0, 80);
  return label || profile;
}

export class BrowserSessionManager {
  private sessions = new Map<string, RunningBrowserSession>();
  private frameListeners = new Set<(frame: BrowserFrame) => void>();

  /**
   * Subscribe to frames pushed by watched profiles. Returns the unsubscribe
   * function.
   */
  onFrame(listener: (frame: BrowserFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /**
   * Stream the profile to whoever is watching for the next [ttlMs].
   *
   * Callers renew this while their viewer is open. Without a live screencast a
   * phone only sees the page as it was when it last asked for a frame, so it
   * misses everything the agent does and everything the page does on its own.
   */
  async watch(profileValue: string, ttlMs = WATCH_TTL_MS): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    const expiresAt = Date.now() + Math.max(1_000, ttlMs);
    if (session.watch) {
      session.watch.expiresAt = expiresAt;
      return;
    }

    const watch: BrowserWatch = {
      expiresAt,
      expiryTimer: setInterval(() => {
        if (Date.now() >= (session.watch?.expiresAt ?? 0)) this.unwatch(session.profile);
      }, 5_000),
      stop: () => {},
      lastSentAt: 0,
    };
    watch.expiryTimer.unref?.();
    session.watch = watch;

    const unsubscribeFrame = session.cdp.on("Page.screencastFrame", (params) => {
      // Chrome pauses the cast until each frame is acknowledged.
      if (typeof params.sessionId === "number") {
        void session.cdp.command("Page.screencastFrameAck", { sessionId: params.sessionId })
          .catch(() => {});
      }
      if (typeof params.data !== "string" || !params.data) return;
      this.queueFrame(session, params.data);
    });
    const unsubscribeNavigation = session.cdp.on("Page.frameNavigated", () => {
      void this.refreshLocation(session).catch(() => {});
    });
    watch.stop = () => {
      unsubscribeFrame();
      unsubscribeNavigation();
      void session.cdp.command("Page.stopScreencast").catch(() => {});
    };

    try {
      await session.cdp.command("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: session.width,
        maxHeight: session.height,
        everyNthFrame: 1,
      });
    } catch (error) {
      this.unwatch(session.profile);
      throw error;
    }
    await this.refreshLocation(session).catch(() => {});
  }

  /**
   * Resize the page the viewers see.
   *
   * Sticky: a viewer choosing desktop or mobile sets the mode for the profile
   * until something asks for a different one. Viewers share one browser, so
   * there is one viewport, and the last request wins.
   */
  async setViewport(profileValue: string, width: number, height: number): Promise<BrowserViewportState> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    const next = {
      width: Math.round(Math.max(320, Math.min(DISPLAY_WIDTH, width))),
      height: Math.round(Math.max(480, Math.min(DISPLAY_HEIGHT, height))),
    };
    if (next.width === session.width && next.height === session.height) {
      return this.viewportState(session);
    }

    await session.cdp.command("Emulation.setDeviceMetricsOverride", {
      width: next.width,
      height: next.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    session.width = next.width;
    session.height = next.height;
    this.touch(session);

    // The screencast caps frames at the size it was started with, so a live
    // one has to be restarted to widen.
    if (session.watch) {
      await session.cdp.command("Page.stopScreencast").catch(() => {});
      await session.cdp.command("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: session.width,
        maxHeight: session.height,
        everyNthFrame: 1,
      }).catch(() => {});
    }
    return this.viewportState(session);
  }

  private viewportState(session: RunningBrowserSession): BrowserViewportState {
    return {
      profile: session.profile,
      label: session.label,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      url: session.url,
      width: session.width,
      height: session.height,
    };
  }

  /** Stop streaming the profile. Safe to call when it was never watched. */
  unwatch(profileValue: string): void {
    const session = this.sessions.get(normalizeBrowserProfile(profileValue));
    if (session) this.stopWatch(session);
  }

  private stopWatch(session: RunningBrowserSession): void {
    const watch = session.watch;
    if (!watch) return;
    session.watch = undefined;
    clearInterval(watch.expiryTimer);
    if (watch.sendTimer) clearTimeout(watch.sendTimer);
    watch.stop();
  }

  /**
   * Hold a frame back to at most one per [FRAME_INTERVAL_MS], always sending
   * the newest one so the phone lands on the page's settled state.
   */
  private queueFrame(session: RunningBrowserSession, imageBase64: string): void {
    const watch = session.watch;
    if (!watch) return;
    watch.pending = {
      profile: session.profile,
      imageBase64,
      mimeType: "image/jpeg",
      width: session.width,
      height: session.height,
      url: session.url,
      title: session.title,
    };
    if (watch.sendTimer) return;
    const wait = Math.max(0, watch.lastSentAt + FRAME_INTERVAL_MS - Date.now());
    watch.sendTimer = setTimeout(() => {
      watch.sendTimer = undefined;
      const frame = watch.pending;
      watch.pending = undefined;
      if (!frame || session.watch !== watch) return;
      watch.lastSentAt = Date.now();
      for (const listener of this.frameListeners) {
        try { listener(frame); } catch {}
      }
    }, wait);
    watch.sendTimer.unref?.();
  }

  private async refreshLocation(session: RunningBrowserSession): Promise<void> {
    const [location, title] = await Promise.all([
      session.cdp.command("Runtime.evaluate", { expression: "location.href", returnByValue: true }),
      session.cdp.command("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
    ]);
    session.url = readStringResult(location) || session.url;
    session.title = readStringResult(title) || session.title;
  }

  async open(
    profileValue: string,
    rawUrl: string,
    labelValue?: string,
    sessionId?: string,
  ): Promise<BrowserSessionSummary> {
    const profile = normalizeBrowserProfile(profileValue);
    const url = normalizeBrowserUrl(rawUrl);
    const existing = this.sessions.get(profile);
    if (existing) {
      existing.label = boundedLabel(labelValue, profile);
      existing.sessionId = sessionId || existing.sessionId;
      existing.url = url;
      await existing.cdp.command("Page.navigate", { url });
      this.touch(existing);
      await wait(300);
      return await this.summary(existing);
    }

    const browserExecutable = resolveBrowserBinary();
    const root = browserDataDir(browserExecutable);
    const profileDir = path.join(root, profile);
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    restrictDirectory(root);
    restrictDirectory(profileDir);
    removeStaleBrowserControlFile(profileDir);
    const display = await startVirtualDisplay(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    const debuggingPort = await reserveLoopbackPort();
    const processHandle = spawn(browserExecutable, [
      ...(display.headless ? ["--headless"] : []),
      `--remote-debugging-port=${debuggingPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      `--window-size=${DISPLAY_WIDTH},${DISPLAY_HEIGHT}`,
      "--force-device-scale-factor=1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-background-mode",
      "--disable-component-update",
      "--disable-features=Translate,OptimizationHints,msEdgeFirstRunExperience",
      "--password-store=basic",
      "about:blank",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: display.env,
    });

    try {
      const targets = await this.waitForPageTarget(debuggingPort, processHandle);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (!page?.webSocketDebuggerUrl) throw new Error("Browser did not create an interactive page.");
      const cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
      await Promise.all([
        cdp.command("Page.enable"),
        cdp.command("Runtime.enable"),
        cdp.command("DOM.enable"),
        cdp.command("Emulation.setDeviceMetricsOverride", {
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
          deviceScaleFactor: 1,
          mobile: false,
        }),
      ]);
      const session: RunningBrowserSession = {
        profile,
        label: boundedLabel(labelValue, profile),
        ...(sessionId ? { sessionId } : {}),
        url,
        title: "",
        profileDir,
        process: processHandle,
        ...(display.process ? { displayProcess: display.process } : {}),
        cdp,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        lastUsedAt: new Date().toISOString(),
      };
      processHandle.once("exit", () => {
        const current = this.sessions.get(profile);
        if (current === session) {
          if (current.idleTimer) clearTimeout(current.idleTimer);
          this.stopWatch(current);
          current.cdp.close();
          current.displayProcess?.kill("SIGTERM");
          this.sessions.delete(profile);
        }
      });
      this.sessions.set(profile, session);
      await cdp.command("Page.navigate", { url });
      this.touch(session);
      await wait(500);
      return await this.summary(session);
    } catch (error) {
      await stopChildProcess(processHandle);
      await stopChildProcess(display.process);
      throw error;
    }
  }

  list(): BrowserSessionSummary[] {
    const root = browserDataDir();
    const saved = new Set<string>();
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name)) saved.add(entry.name);
      }
    } catch {}
    for (const profile of this.sessions.keys()) saved.add(profile);
    return [...saved].sort().map((profile) => {
      const running = this.sessions.get(profile);
      return running
        ? {
            profile,
            label: running.label,
            running: true,
            sessionId: running.sessionId,
            url: running.url,
            lastUsedAt: running.lastUsedAt,
          }
        : { profile, label: profile, running: false };
    });
  }

  active(): BrowserSessionSummary[] {
    return [...this.sessions.values()].map((session) => ({
      profile: session.profile,
      label: session.label,
      running: true,
      sessionId: session.sessionId,
      url: session.url,
      lastUsedAt: session.lastUsedAt,
    }));
  }

  async status(profileValue: string): Promise<BrowserSessionSummary> {
    const profile = normalizeBrowserProfile(profileValue);
    const session = this.require(profile);
    return await this.summary(session);
  }

  async frame(profileValue: string): Promise<BrowserFrame> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.touch(session);
    const [capture, location, title] = await Promise.all([
      session.cdp.command("Page.captureScreenshot", {
        format: "jpeg",
        quality: 72,
        fromSurface: true,
        captureBeyondViewport: false,
      }),
      session.cdp.command("Runtime.evaluate", { expression: "location.href", returnByValue: true }),
      session.cdp.command("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
    ]);
    const imageBase64 = typeof capture.data === "string" ? capture.data : "";
    if (!imageBase64) throw new Error("Browser did not return a frame.");
    const url = readStringResult(location) || session.url;
    session.url = url;
    session.title = readStringResult(title) || session.title;
    return {
      profile: session.profile,
      imageBase64,
      mimeType: "image/jpeg",
      width: session.width,
      height: session.height,
      url,
      title: readStringResult(title),
    };
  }

  async phoneInput(profileValue: string, input: BrowserPhoneInput): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.touch(session);
    switch (input.action) {
      case "tap": {
        const x = Math.max(0, Math.min(session.width, Number(input.x)));
        const y = Math.max(0, Math.min(session.height, Number(input.y)));
        await session.cdp.command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await session.cdp.command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        break;
      }
      case "text":
        if (input.text.length > 16_384) throw new Error("Browser text input is too large.");
        await session.cdp.command("Input.insertText", { text: input.text });
        break;
      case "key":
        await this.pressKey(session, input.key);
        break;
      case "scroll":
        await session.cdp.command("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: session.width / 2,
          y: session.height / 2,
          deltaX: Math.max(-5000, Math.min(5000, Number(input.deltaX || 0))),
          deltaY: Math.max(-5000, Math.min(5000, Number(input.deltaY))),
        });
        break;
      case "navigate":
        await session.cdp.command("Page.navigate", { url: normalizeBrowserUrl(input.url) });
        break;
      case "reload":
        await session.cdp.command("Page.reload", { ignoreCache: false });
        break;
      case "back":
        await this.historyStep(session, -1);
        break;
      case "forward":
        await this.historyStep(session, 1);
        break;
    }
  }

  async snapshot(profileValue: string): Promise<BrowserSnapshot> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.touch(session);
    const expression = String.raw`(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      document.querySelectorAll('[data-socketagent-ref]').forEach((el) => el.removeAttribute('data-socketagent-ref'));
      const selector = [
        'a','button','input','textarea','select','summary',
        '[contenteditable="true"]',
        // Component libraries build controls out of divs with a role, so
        // without these a checkbox or menu item is invisible and unclickable.
        '[role="button"]','[role="link"]','[role="checkbox"]','[role="radio"]',
        '[role="switch"]','[role="tab"]','[role="option"]','[role="combobox"]',
        '[role="menuitem"]','[role="menuitemcheckbox"]','[role="menuitemradio"]',
        '[role="treeitem"]','[role="slider"]'
      ].join(',');
      const elements = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, 300).map((el, index) => {
        const ref = 'sa-' + (index + 1);
        el.setAttribute('data-socketagent-ref', ref);
        const type = String(el.getAttribute('type') || '').toLowerCase();
        const secretHint = [type, el.id, el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ').toLowerCase();
        const secret = type === 'password' || /(password|passcode|one-time|otp|mfa|token|secret|recovery|verification.code)/.test(secretHint);
        const checkedAttr = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected');
        const checked = checkedAttr === null
          ? (type === 'checkbox' || type === 'radio' ? Boolean(el.checked) : undefined)
          : checkedAttr === 'true';
        return {
          ref,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          ...(checked === undefined ? {} : { checked }),
          name: String(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 240),
          type: type || undefined,
          value: secret ? undefined : (typeof el.value === 'string' ? el.value.slice(0, 500) : undefined),
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true')
        };
      });
      return JSON.stringify({
        url: location.href,
        title: document.title,
        text: String(document.body && document.body.innerText || '').slice(0, 30000),
        elements
      });
    })()`;
    const result = await session.cdp.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const serialized = readStringResult(result);
    if (!serialized) throw new Error("Browser page could not be inspected.");
    const parsed = JSON.parse(serialized) as Omit<BrowserSnapshot, "profile">;
    session.url = parsed.url || session.url;
    return { profile: session.profile, ...parsed };
  }

  async click(profileValue: string, ref: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    const safeRef = String(ref).trim();
    if (!/^sa-[1-9][0-9]{0,3}$/.test(safeRef)) throw new Error("Browser element reference is invalid. Refresh the snapshot.");
    const expression = `(() => { const el = document.querySelector('[data-socketagent-ref="${safeRef}"]'); if (!el) return ''; el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2}); })()`;
    const result = await session.cdp.command("Runtime.evaluate", { expression, returnByValue: true });
    const serialized = readStringResult(result);
    if (!serialized) throw new Error("Browser element is no longer available. Refresh the snapshot.");
    const point = JSON.parse(serialized) as { x: number; y: number };
    await this.phoneInput(session.profile, { action: "tap", x: point.x, y: point.y });
  }

  async type(profileValue: string, ref: string, text: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    const safeRef = String(ref).trim();
    if (!/^sa-[1-9][0-9]{0,3}$/.test(safeRef)) throw new Error("Browser element reference is invalid. Refresh the snapshot.");
    if (text.length > 16_384) throw new Error("Browser text input is too large.");
    const expression = `(() => { const el = document.querySelector('[data-socketagent-ref="${safeRef}"]'); if (!el) return false; const hint = [el.getAttribute('type'), el.id, el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ').toLowerCase(); if (/(password|passcode|one-time|otp|mfa|token|secret|recovery|verification.code)/.test(hint)) return 'password'; el.focus(); if ('select' in el) el.select(); return true; })()`;
    const result = await session.cdp.command("Runtime.evaluate", { expression, returnByValue: true });
    const nested = result.result as JsonRecord | undefined;
    if (nested?.value === "password") throw new Error("The agent cannot type into password fields. Open the protected phone browser.");
    if (nested?.value !== true) throw new Error("Browser element is no longer available. Refresh the snapshot.");
    await this.pressKey(session, "CTRL+A");
    await session.cdp.command("Input.insertText", { text });
  }

  async navigate(profileValue: string, rawUrl: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    session.url = normalizeBrowserUrl(rawUrl);
    await this.phoneInput(profileValue, { action: "navigate", url: rawUrl });
  }

  async key(profileValue: string, key: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    await this.pressKey(session, key);
  }

  async scroll(profileValue: string, deltaY: number): Promise<void> {
    await this.phoneInput(profileValue, { action: "scroll", deltaY });
  }

  async readClipboard(profileValue: string): Promise<string> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    await this.grantClipboardAccess(session);
    const result = await session.cdp.command("Runtime.evaluate", {
      expression: "navigator.clipboard.readText()",
      returnByValue: true,
      awaitPromise: true,
    });
    const exception = runtimeExceptionDescription(result);
    if (exception) throw new Error(`The browser page did not allow clipboard access: ${exception}`);
    const text = readStringResult(result);
    if (text.length > 65_536) throw new Error("Browser clipboard text is too large.");
    this.touch(session);
    return text;
  }

  async writeClipboard(profileValue: string, text: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    if (text.length > 65_536) throw new Error("Browser clipboard text is too large.");
    await this.grantClipboardAccess(session);
    const result = await session.cdp.command("Runtime.evaluate", {
      expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
      returnByValue: true,
      awaitPromise: true,
    });
    const exception = runtimeExceptionDescription(result);
    if (exception) {
      throw new Error(`The browser page did not allow clipboard access: ${exception}`);
    }
    this.touch(session);
  }

  async close(profileValue: string): Promise<void> {
    const profile = normalizeBrowserProfile(profileValue);
    const session = this.sessions.get(profile);
    if (!session) return;
    this.sessions.delete(profile);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.stopWatch(session);
    session.cdp.close();
    await stopChildProcess(session.process);
    await stopChildProcess(session.displayProcess);
  }

  async clear(profileValue: string): Promise<void> {
    const profile = normalizeBrowserProfile(profileValue);
    await this.close(profile);
    const root = browserDataDir();
    const target = path.join(root, profile);
    if (path.dirname(target) !== root) throw new Error("Browser profile path is invalid.");
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((profile) => this.close(profile)));
  }

  private require(profile: string): RunningBrowserSession {
    const session = this.sessions.get(profile);
    if (!session) throw new Error(`Browser profile ${profile} is not running. Open it first.`);
    return session;
  }

  private touch(session: RunningBrowserSession): void {
    session.lastUsedAt = new Date().toISOString();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => void this.close(session.profile), IDLE_CLOSE_MS);
    session.idleTimer.unref?.();
  }

  private async summary(session: RunningBrowserSession): Promise<BrowserSessionSummary> {
    const [location, title] = await Promise.all([
      session.cdp.command("Runtime.evaluate", { expression: "location.href", returnByValue: true }),
      session.cdp.command("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
    ]);
    const url = readStringResult(location) || session.url;
    session.url = url;
    session.title = readStringResult(title) || session.title;
    return {
      profile: session.profile,
      label: session.label,
      running: true,
      sessionId: session.sessionId,
      url,
      title: readStringResult(title),
      lastUsedAt: session.lastUsedAt,
    };
  }

  private async pressKey(session: RunningBrowserSession, rawKey: string): Promise<void> {
    const key = String(rawKey || "").trim().toUpperCase();
    const definitions: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; modifiers?: number }> = {
      ENTER: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
      TAB: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
      BACKSPACE: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      ESCAPE: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      "CTRL+A": { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
    };
    const definition = definitions[key];
    if (!definition) throw new Error("Supported browser keys are Enter, Tab, Backspace, Escape, and Ctrl+A.");
    await session.cdp.command("Input.dispatchKeyEvent", { type: "keyDown", ...definition });
    await session.cdp.command("Input.dispatchKeyEvent", { type: "keyUp", ...definition });
    this.touch(session);
  }

  private async grantClipboardAccess(session: RunningBrowserSession): Promise<void> {
    await session.cdp.command("Page.bringToFront");
    const location = await session.cdp.command("Runtime.evaluate", {
      expression: "location.origin",
      returnByValue: true,
    });
    const origin = readStringResult(location);
    if (!/^https?:\/\//.test(origin)) {
      throw new Error("Clipboard access requires an HTTP or HTTPS page.");
    }
    await session.cdp.command("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
  }

  private async historyStep(session: RunningBrowserSession, delta: number): Promise<void> {
    const result = await session.cdp.command("Page.getNavigationHistory");
    const currentIndex = Number(result.currentIndex);
    const entries = Array.isArray(result.entries) ? result.entries as JsonRecord[] : [];
    const target = entries[currentIndex + delta];
    if (target && typeof target.id === "number") {
      await session.cdp.command("Page.navigateToHistoryEntry", { entryId: target.id });
    }
  }

  private async waitForPageTarget(port: number, processHandle: ChildProcess): Promise<CdpTarget[]> {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (processHandle.exitCode !== null) {
        throw new Error("Browser exited before its control channel opened.");
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await response.json() as CdpTarget[];
        if (targets.some((target) => target.type === "page" && target.webSocketDebuggerUrl)) return targets;
      } catch {}
      await wait(100);
    }
    throw new Error("Browser page did not become available within 15 seconds.");
  }
}

export const browserSessionManager = new BrowserSessionManager();
