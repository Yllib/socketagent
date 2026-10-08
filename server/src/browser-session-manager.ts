import * as fs from "node:fs";
import { z } from "zod";
import { isRecord, unknownArray, errorMessage } from "./value-guards";
import * as os from "node:os";
import * as path from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type {
  BrowserPrompt,
  BrowserPromptClosedServerMessage,
  BrowserPromptResponseMessage,
  BrowserPromptServerMessage,
  BrowserTabsServerMessage,
} from "./protocol";
import { PICKER_BINDING, PICKER_SCRIPT, PICKER_WORLD, applyPickerExpression, parsePickerReport } from "./browser-page-pickers";

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
  /** Set on streamed frames. A viewer acknowledges it once the frame is on screen. */
  seq?: number;
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
  /** The embedded frame holding the element. Absent for the page itself. */
  frame?: number;
}

export interface BrowserSnapshot {
  profile: string;
  url: string;
  title: string;
  text: string;
  elements: BrowserSnapshotElement[];
  /** Embedded frames with content, numbered as elements reference them. */
  frames: Array<{ frame: number; url: string }>;
}

export type BrowserMouseButton = "left" | "middle" | "right" | "none";

export type BrowserPhoneInput =
  | { action: "tap"; x: number; y: number }
  | { action: "text"; text: string }
  | { action: "key"; key: string }
  | { action: "scroll"; deltaX?: number; deltaY: number; x?: number; y?: number }
  | { action: "navigate"; url: string }
  | { action: "reload" }
  | { action: "back" }
  | { action: "forward" }
  | {
    action: "pointer";
    phase: "down" | "move" | "up";
    x: number;
    y: number;
    button: BrowserMouseButton;
    /** Buttons held: 1 left, 2 right, 4 middle. */
    buttons: number;
    clickCount: number;
    /** 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
    modifiers: number;
  }
  | {
    action: "keyboard";
    phase: "down" | "up";
    /** DOM `KeyboardEvent.code`, or empty when the viewer only knows the character. */
    code: string;
    /** DOM `KeyboardEvent.key`. */
    key: string;
    /** The character the key types, if any. */
    text?: string;
    modifiers: number;
    repeat: boolean;
  };

/** What a viewer said to a prompt. */
export type BrowserPromptAnswer = Omit<BrowserPromptResponseMessage, "type" | "profile" | "id">;

/** Messages for a profile's viewers that are not frames. */
export type BrowserSessionEvent =
  | BrowserPromptServerMessage
  | BrowserPromptClosedServerMessage
  | BrowserTabsServerMessage;

/** What the focused element expects typed into it. */
export interface BrowserFocusState {
  editable: boolean;
  inputKind?: "text" | "password" | "email" | "number" | "tel" | "url" | "multiline";
}

interface CdpResponse {
  id?: number;
  method?: string;
  /** Set on traffic for an attached child target, such as an out-of-process frame. */
  sessionId?: string;
  params?: JsonRecord;
  result?: JsonRecord;
  error?: { message?: string };
}

interface CdpTarget {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface BrowserTab {
  id: string;
  url: string;
  title: string;
  /** The tab that opened this one, which a closing pop-up hands the view back to. */
  openerId?: string;
}

/** A prompt the page is waiting on, and how to give the page the viewer's answer. */
interface OpenPrompt {
  id: string;
  prompt: BrowserPrompt;
  answer: (answer: BrowserPromptAnswer) => Promise<void>;
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
  /** The newest frame not yet sent, held back by pacing. */
  pending?: BrowserFrame;
  sendTimer?: NodeJS.Timeout;
  lastSentAt: number;
  /** Numbers each sent frame so an acknowledgement names the one shown. */
  seq: number;
  /** When each sent frame that no viewer has acknowledged went out, by seq. */
  unacked: Map<number, number>;
  /**
   * Set once a viewer acknowledges a frame. Until then the stream is paced by
   * the connection's send buffer alone, which is all older apps allow.
   */
  acked: boolean;
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
  /** Chrome's debugging port, for connecting to tabs as they open. */
  port: number;
  /** Connection to the active tab. Everything that acts on the page uses it. */
  cdp: CdpClient;
  /** Browser-wide connection that sees tabs open, change, and close. */
  browserCdp: CdpClient;
  /** Open tabs in the order they opened, by target ID. */
  tabs: Map<string, BrowserTab>;
  activeTab: string;
  /** What the page is waiting on a viewer for, if anything. */
  prompt?: OpenPrompt;
  /** Inputs and navigations waiting on Chrome, released when the page stops to ask the viewer something. */
  blockedWaiters: Set<() => void>;
  width: number;
  height: number;
  lastUsedAt: string;
  idleTimer?: NodeJS.Timeout;
  watch?: BrowserWatch;
  /** CDP sessions of attached out-of-process frames. */
  frameTargets: Set<string>;
  /** The frame each element ref from the latest snapshot lives in. */
  refFrames: Map<string, PageFrame>;
  /** The isolated world agent scripts use in each embedded frame, by frame ID. */
  frameContexts: Map<string, number>;
  /** Viewer input runs one event at a time, in arrival order. */
  inputQueue: Promise<void>;
  /** When a viewer last sent input, so frames speed up while someone interacts. */
  lastInputAt: number;
}

/** One frame of the page, as the agent's scripts reach it. */
interface PageFrame {
  frameId: string;
  /** CDP session of the out-of-process frame hosting it. Absent when it runs in the page's process. */
  target?: string;
  parentFrameId?: string;
  url: string;
}

/** A frame's content box in page viewport coordinates. */
interface FrameBox { x: number; y: number; width: number; height: number }

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
export const WATCH_TTL_MS = 20_000;
/** Floor on the gap between pushed frames, so a busy page cannot flood a phone. */
const FRAME_INTERVAL_MS = 200;
/** The faster floor while a viewer is typing, dragging, or scrolling. */
const INTERACTIVE_FRAME_INTERVAL_MS = 66;
/** How long after the last input frames stay at the interactive rate. */
const INTERACTIVE_WINDOW_MS = 2_000;
/**
 * Frames a viewer may have in transit at once. More keeps a slow link busy
 * but queues stale frames, which is what makes the picture lag behind input.
 */
const MAX_UNACKED_FRAMES = 2;
/** An unacknowledged frame this old counts as lost, so a dropped ack cannot stall the stream. */
const FRAME_ACK_TIMEOUT_MS = 1_000;
/** How soon a frame held for a backed-up connection checks again. */
const CONGESTION_RETRY_MS = 40;

/** Windows virtual key codes, which Chrome needs to run keys like Backspace and arrows. */
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 16, ShiftRight: 16,
  ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20,
  Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111,
  NumLock: 144, ScrollLock: 145,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192,
  BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
};

/** Key names for keys that type nothing, by their DOM code. */
const NAMED_KEYS: Record<string, string> = {
  ShiftLeft: "Shift", ShiftRight: "Shift", ControlLeft: "Control", ControlRight: "Control",
  AltLeft: "Alt", AltRight: "Alt", MetaLeft: "Meta", MetaRight: "Meta", NumpadEnter: "Enter",
};

function virtualKeyCode(code: string, key: string): number {
  const known = VIRTUAL_KEY_CODES[code];
  if (known !== undefined) return known;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].charCodeAt(0);
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1].charCodeAt(0);
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return 96 + Number(numpad[1]);
  const fn = /^F([0-9]{1,2})$/.exec(code);
  if (fn) return 111 + Number(fn[1]);
  if (key.length === 1 && /[a-z0-9]/i.test(key)) return key.toUpperCase().charCodeAt(0);
  return 0;
}

/** 1 for the left key of a pair, 2 for the right, 3 for the numeric keypad. */
function keyLocation(code: string): number {
  if (code.startsWith("Numpad")) return 3;
  if (/(Shift|Control|Alt|Meta)Right$/.test(code)) return 2;
  if (/(Shift|Control|Alt|Meta)Left$/.test(code)) return 1;
  return 0;
}

/**
 * Editing shortcuts Chrome on macOS only runs when named, since its key
 * bindings live in the window that CDP input bypasses. Linux and Windows
 * builds handle them from the key event alone.
 */
function macEditingCommand(key: string, modifiers: number): string | undefined {
  if (process.platform !== "darwin" || (modifiers & 4) === 0) return undefined;
  const shift = (modifiers & 8) !== 0;
  switch (key.toLowerCase()) {
    case "a": return "selectAll";
    case "c": return "copy";
    case "v": return "paste";
    case "x": return "cut";
    case "z": return shift ? "redo" : "undo";
    default: return undefined;
  }
}

/**
 * Finds the element with focus, following open shadow roots and same-origin
 * frames, and reports whether it takes typing. Returns "frame" when focus is
 * inside a cross-origin frame this document cannot see into.
 */
const FOCUS_EXPRESSION = `(() => {
  let el = document.activeElement;
  for (let depth = 0; el && depth < 20; depth++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let inner = null;
      try { inner = el.contentDocument && el.contentDocument.activeElement; } catch (e) { return "frame"; }
      if (!inner) return "frame";
      el = inner;
      continue;
    }
    break;
  }
  if (!el || el.disabled || el.readOnly) return "none";
  if (el.isContentEditable || el.tagName === "TEXTAREA") return "multiline";
  if (el.tagName !== "INPUT") return "none";
  const type = (el.type || "text").toLowerCase();
  if (["button", "checkbox", "radio", "submit", "reset", "file", "image", "color", "range", "hidden"].includes(type)) return "none";
  if (type === "password") return "password";
  if (type === "email") return "email";
  if (type === "number") return "number";
  if (type === "tel") return "tel";
  if (type === "url") return "url";
  return "text";
})()`;

/** The same check for an out-of-process frame, which answers only while it holds focus. */
const FRAME_FOCUS_EXPRESSION = `(document.hasFocus() ? ${FOCUS_EXPRESSION} : "unfocused")`;
/** Element refs a snapshot hands out per frame and in total. */
const SNAPSHOT_FRAME_ELEMENTS = 300;
const SNAPSHOT_TOTAL_ELEMENTS = 600;
/** Text a snapshot keeps from the page itself, from each embedded frame, and in total. */
const SNAPSHOT_PAGE_TEXT = 30_000;
const SNAPSHOT_FRAME_TEXT = 10_000;
const SNAPSHOT_TOTAL_TEXT = 60_000;
/** Chrome runs cross-site frames in their own processes; this attaches to each as it appears. */
const FRAME_AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }] };

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
        if ((isRecord(error) ? error.code : undefined) !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if ((isRecord(error) ? error.code : undefined) !== "ENOENT"
      && !String(errorMessage(error)).startsWith("Browser profile is still owned")) {
      throw new Error(`Could not inspect the browser profile lock: ${errorMessage(error)}`);
    }
    if (String(errorMessage(error)).startsWith("Browser profile is still owned")) throw error;
  }

  for (const name of ["DevToolsActivePort", "SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.rmSync(path.join(profileDir, name), { force: true });
    } catch (error) {
      throw new Error(
        `Could not remove stale browser control file ${name}: ${errorMessage(error)}`,
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
    displayPipe.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split(/\r?\n/, 1)[0].trim();
      if (/^[0-9]+$/.test(line)) finish(undefined, line);
    });
    displayPipe.once("error", (error) => finish(error));
  }).catch((error: unknown) => {
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
  private listeners = new Map<string, Set<(params: JsonRecord, sessionId?: string) => void>>();

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

  /** Sends a command to the page, or to the attached child target [sessionId]. */
  async command(method: string, params: JsonRecord = {}, sessionId?: string): Promise<JsonRecord> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("Browser connection is not open.");
    const id = ++this.nextId;
    return await new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /**
   * Subscribe to a CDP event. Handlers also get the child session it came
   * from, if any. Returns the unsubscribe function.
   */
  on(method: string, handler: (params: JsonRecord, sessionId?: string) => void): () => void {
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
    try {
      message = z.object({
        id: z.number().optional(), method: z.string().optional(), sessionId: z.string().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        result: z.record(z.string(), z.unknown()).optional(),
        error: z.object({ message: z.string().optional() }).optional(),
      }).parse(JSON.parse(raw));
    }
    catch { return; }
    if (typeof message.id !== "number") {
      // Events carry a method instead of an id.
      if (typeof message.method !== "string") return;
      for (const handler of this.listeners.get(message.method) ?? []) {
        try { handler(message.params ?? {}, message.sessionId); } catch {}
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
  if (!isRecord(nested)) return "";
  const value = nested.value;
  return typeof value === "string" ? value : "";
}

function runtimeExceptionDescription(result: JsonRecord): string {
  const details = result.exceptionDetails;
  if (!isRecord(details)) return "";
  const record = details;
  const exception = record.exception;
  if (isRecord(exception)) {
    const description = exception.description;
    if (typeof description === "string") return description.split("\n", 1)[0].slice(0, 300);
  }
  return typeof record.text === "string" ? record.text.slice(0, 300) : "";
}

/**
 * Attaches to every out-of-process frame, now and as frames load, and keeps
 * [targets] in step. Cross-site frames run in their own renderer, so scripts
 * in the page cannot see into them.
 */
async function trackFrameTargets(cdp: CdpClient, targets: Set<string>): Promise<void> {
  cdp.on("Target.attachedToTarget", (params) => {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    if (!sessionId || !isRecord(params.targetInfo) || params.targetInfo.type !== "iframe") return;
    targets.add(sessionId);
    // A cross-site frame's own cross-site frames attach through it.
    void cdp.command("Target.setAutoAttach", FRAME_AUTO_ATTACH, sessionId).catch(() => {});
    void cdp.command("DOM.enable", {}, sessionId).catch(() => {});
    void cdp.command("Runtime.enable", {}, sessionId).catch(() => {});
    void installPickers(cdp, sessionId).catch(() => {});
  });
  cdp.on("Target.detachedFromTarget", (params) => {
    if (typeof params.sessionId === "string") targets.delete(params.sessionId);
  });
  await cdp.command("Target.setAutoAttach", FRAME_AUTO_ATTACH);
}

/** Runs the picker script in every frame of a page or out-of-process frame, now and after each navigation. */
async function installPickers(cdp: CdpClient, sessionId?: string): Promise<void> {
  await cdp.command("Runtime.addBinding", { name: PICKER_BINDING, executionContextName: PICKER_WORLD }, sessionId);
  await cdp.command("Page.addScriptToEvaluateOnNewDocument", {
    source: PICKER_SCRIPT,
    worldName: PICKER_WORLD,
    runImmediately: true,
  }, sessionId);
}

const targetInfoSchema = z.object({
  targetId: z.string(),
  type: z.string(),
  url: z.string(),
  title: z.string(),
  openerId: z.string().optional(),
});

/** The tab a Target event describes, or undefined for workers, frames, and other targets. */
function tabFromTargetInfo(value: unknown): BrowserTab | undefined {
  const parsed = targetInfoSchema.safeParse(value);
  if (!parsed.success || parsed.data.type !== "page") return undefined;
  const { targetId, url, title, openerId } = parsed.data;
  return { id: targetId, url, title, ...(openerId ? { openerId } : {}) };
}

const dialogTypeSchema = z.enum(["alert", "confirm", "prompt", "beforeunload"]);

const snapshotFrameSchema = z.object({
  url: z.string(), title: z.string(), text: z.string(),
  elements: z.array(z.object({
    ref: z.string(), tag: z.string(), role: z.string().optional(), name: z.string(),
    type: z.string().optional(), value: z.string().optional(),
    checked: z.boolean().optional(), disabled: z.boolean(),
  })),
});

/**
 * Lists one frame's text and visible controls, tagging each control with a
 * ref numbered from [start] so refs stay unique across frames.
 */
function snapshotExpression(start: number, limit: number, textLimit: number): string {
  return String.raw`(() => {
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
    const elements = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, ${limit}).map((el, index) => {
      const ref = 'sa-' + (${start} + index + 1);
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
      text: String(document.body && document.body.innerText || '').slice(0, ${textLimit}),
      elements
    });
  })()`;
}

/**
 * Scrolls a tagged element into view and returns its center in its frame's
 * viewport. With [forTyping], it refuses credential fields and focuses the
 * element instead.
 */
function elementExpression(ref: string, forTyping: boolean): string {
  return `(() => {
    const el = document.querySelector('[data-socketagent-ref="${ref}"]');
    if (!el) return '';
    if (${forTyping}) {
      const hint = [el.getAttribute('type'), el.id, el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ').toLowerCase();
      if (/(password|passcode|one-time|otp|mfa|token|secret|recovery|verification.code)/.test(hint)) return JSON.stringify({ secret: true });
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (${forTyping}) el.focus();
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`;
}

/** A tagged element's center in its frame's viewport, without scrolling. */
function elementCenterExpression(ref: string): string {
  return `(() => {
    const el = document.querySelector('[data-socketagent-ref="${ref}"]');
    if (!el) return '';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`;
}

const elementPointSchema = z.union([
  z.object({ secret: z.literal(true) }),
  z.object({ x: z.number(), y: z.number() }),
]);

/** Run on an iframe element: its content box in the parent frame's viewport, or null when hidden. */
const FRAME_BOX_FUNCTION = `function () {
  const style = getComputedStyle(this);
  if (style.visibility === 'hidden' || style.display === 'none') return 'null';
  const rect = this.getBoundingClientRect();
  const left = this.clientLeft + parseFloat(style.paddingLeft || '0');
  const top = this.clientTop + parseFloat(style.paddingTop || '0');
  const width = this.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
  const height = this.clientHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0');
  return JSON.stringify({ x: rect.left + left, y: rect.top + top, width, height });
}`;

const frameBoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable();

function boundedLabel(value: string | undefined, profile: string): string {
  const label = String(value || "").trim().replace(/[\r\n\t]+/g, " ").slice(0, 80);
  return label || profile;
}

export class BrowserSessionManager {
  private sessions = new Map<string, RunningBrowserSession>();
  private frameListeners = new Set<(frame: BrowserFrame) => void>();
  private eventListeners = new Set<(event: BrowserSessionEvent) => void>();
  /** Whether the connections frames go out on are still sending earlier data. */
  private framesBackedUp: () => boolean = () => false;

  /** Hold streamed frames while [check] reports the outgoing connections backed up. */
  setFrameCongestionCheck(check: () => boolean): void {
    this.framesBackedUp = check;
  }

  /**
   * Subscribe to frames pushed by watched profiles. Returns the unsubscribe
   * function.
   */
  onFrame(listener: (frame: BrowserFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Subscribe to prompts and tab changes for viewers. Returns the unsubscribe function. */
  onEvent(listener: (event: BrowserSessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emit(event: BrowserSessionEvent): void {
    for (const listener of this.eventListeners) {
      try { listener(event); } catch {}
    }
  }

  /** Resend the tabs and any open prompt, for a viewer that just arrived. */
  replayState(profileValue: string): void {
    const session = this.sessions.get(normalizeBrowserProfile(profileValue));
    if (!session) return;
    this.emitTabs(session);
    const open = session.prompt;
    if (open) this.emit({ type: "browser_prompt", profile: session.profile, id: open.id, prompt: open.prompt });
  }

  private emitTabs(session: RunningBrowserSession): void {
    this.emit({
      type: "browser_tabs",
      profile: session.profile,
      tabs: [...session.tabs.values()].map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.id === session.activeTab,
      })),
    });
  }

  /**
   * Answer prompt [id]. Ignored when it is no longer the open one, because
   * another device answered it or the page moved on.
   */
  async answerPrompt(profileValue: string, id: string, answer: BrowserPromptAnswer): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    const open = session.prompt;
    if (!open || open.id !== id) return;
    this.touch(session);
    this.closePrompt(session);
    await open.answer(answer);
  }

  /** Show a new prompt. One the page was still waiting on is cancelled, so nothing stays blocked. */
  private openPrompt(
    session: RunningBrowserSession,
    prompt: BrowserPrompt,
    answer: (answer: BrowserPromptAnswer) => Promise<void>,
  ): void {
    this.cancelPrompt(session);
    const id = randomUUID();
    session.prompt = { id, prompt, answer };
    if (prompt.kind === "dialog" || prompt.kind === "auth") {
      for (const release of session.blockedWaiters) release();
      session.blockedWaiters.clear();
    }
    this.emit({ type: "browser_prompt", profile: session.profile, id, prompt });
  }

  private cancelPrompt(session: RunningBrowserSession): void {
    const open = session.prompt;
    if (!open) return;
    this.closePrompt(session);
    void open.answer({ accept: false }).catch(() => {});
  }

  private closePrompt(session: RunningBrowserSession): void {
    const open = session.prompt;
    if (!open) return;
    session.prompt = undefined;
    this.emit({ type: "browser_prompt_closed", profile: session.profile, id: open.id });
  }

  /** A JavaScript dialog blocks the page's scripts, so anything that evaluates in it would hang. */
  private openDialog(session: RunningBrowserSession): Extract<BrowserPrompt, { kind: "dialog" }> | undefined {
    const prompt = session.prompt?.prompt;
    return prompt?.kind === "dialog" ? prompt : undefined;
  }

  private assertNoDialog(session: RunningBrowserSession): void {
    const dialog = this.openDialog(session);
    if (dialog) {
      throw new Error(`The page is showing a ${dialog.dialogType} dialog ("${dialog.message.slice(0, 200)}"). `
        + "Ask the user to answer it in the phone browser.");
    }
  }

  /**
   * Send input or a navigation to the page. Chrome does not finish one that
   * opens a JavaScript dialog or meets a sign-in challenge until it is
   * answered, so stop waiting once the page asks. Otherwise the viewer's
   * answer would queue behind it.
   */
  private async dispatchInput(session: RunningBrowserSession, method: string, params: JsonRecord): Promise<void> {
    const waitingOn = session.prompt?.prompt.kind;
    if (waitingOn === "dialog" || waitingOn === "auth") return;
    const sent = session.cdp.command(method, params);
    let release = () => {};
    const dialogOpened = new Promise<void>((resolve) => {
      release = resolve;
      session.blockedWaiters.add(resolve);
    });
    try {
      await Promise.race([sent, dialogOpened]);
    } finally {
      session.blockedWaiters.delete(release);
      sent.catch(() => {});
    }
  }

  /** Where viewers upload files for the page's file chooser. */
  private uploadDir(session: RunningBrowserSession): string {
    const dir = path.join(session.profileDir, "SocketAgent Uploads");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Prepare a tab's connection: the viewport, and the handlers that turn
   * dialogs, file choosers, sign-in challenges, and native pickers into
   * prompts. Handlers ignore a tab once it is no longer the active one.
   */
  private async setupPage(session: RunningBrowserSession, cdp: CdpClient, frameTargets: Set<string>): Promise<void> {
    const active = () => session.cdp === cdp;
    cdp.on("Page.javascriptDialogOpening", (params) => {
      if (!active()) return;
      const dialogType = dialogTypeSchema.catch("alert").parse(params.type);
      const defaultText = dialogType === "prompt" && typeof params.defaultPrompt === "string" ? params.defaultPrompt : undefined;
      this.openPrompt(session, {
        kind: "dialog",
        dialogType,
        message: typeof params.message === "string" ? params.message : "",
        ...(defaultText !== undefined ? { defaultText } : {}),
      }, async (answer) => {
        await cdp.command("Page.handleJavaScriptDialog", {
          accept: answer.accept,
          ...(answer.value !== undefined ? { promptText: answer.value } : {}),
        });
      });
    });
    cdp.on("Page.javascriptDialogClosed", () => {
      if (active() && this.openDialog(session)) this.closePrompt(session);
    });
    cdp.on("Page.fileChooserOpened", (params) => {
      if (!active() || typeof params.backendNodeId !== "number") return;
      const backendNodeId = params.backendNodeId;
      const uploadDir = this.uploadDir(session);
      this.openPrompt(session, { kind: "file", multiple: params.mode === "selectMultiple", uploadDir }, async (answer) => {
        if (!answer.accept || !answer.files?.length) return;
        const files = answer.files.map((file) => {
          const resolved = path.resolve(file);
          if (path.dirname(resolved) !== uploadDir || !fs.statSync(resolved).isFile()) {
            throw new Error("Browser uploads must come from the profile's upload folder.");
          }
          return resolved;
        });
        await cdp.command("DOM.setFileInputFiles", { files, backendNodeId });
      });
    });
    // Navigations pause so sign-in challenges can be answered. Everything else goes straight on.
    cdp.on("Fetch.requestPaused", (params) => {
      if (typeof params.requestId !== "string") return;
      void cdp.command("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
    });
    cdp.on("Fetch.authRequired", (params) => {
      if (typeof params.requestId !== "string") return;
      const requestId = params.requestId;
      const respond = (authChallengeResponse: JsonRecord) =>
        cdp.command("Fetch.continueWithAuth", { requestId, authChallengeResponse });
      if (!active()) {
        void respond({ response: "CancelAuth" }).catch(() => {});
        return;
      }
      const challenge = isRecord(params.authChallenge) ? params.authChallenge : {};
      const realm = typeof challenge.realm === "string" ? challenge.realm : "";
      this.openPrompt(session, {
        kind: "auth",
        origin: typeof challenge.origin === "string" ? challenge.origin : "",
        scheme: typeof challenge.scheme === "string" ? challenge.scheme : "basic",
        ...(realm ? { realm } : {}),
        proxy: challenge.source === "Proxy",
      }, async (answer) => {
        await respond(answer.accept
          ? { response: "ProvideCredentials", username: answer.username ?? "", password: answer.password ?? "" }
          : { response: "CancelAuth" });
      });
    });
    cdp.on("Runtime.bindingCalled", (params, sessionId) => {
      if (!active() || params.name !== PICKER_BINDING || typeof params.payload !== "string") return;
      const report = parsePickerReport(params.payload);
      const contextId = params.executionContextId;
      if (!report || typeof contextId !== "number") return;
      this.openPrompt(session, report.prompt, async (answer) => {
        if (!answer.accept || answer.value === undefined) return;
        await cdp.command("Runtime.evaluate", {
          expression: applyPickerExpression(report.id, answer.value),
          contextId,
        }, sessionId);
      });
    });
    cdp.on("Page.frameNavigated", (params) => {
      // A picker belongs to the document that reported it.
      if (!active() || !isRecord(params.frame) || params.frame.parentId) return;
      const kind = session.prompt?.prompt.kind;
      if (kind === "select" || kind === "picker") this.closePrompt(session);
    });
    await Promise.all([
      trackFrameTargets(cdp, frameTargets),
      cdp.command("Page.enable"),
      cdp.command("Runtime.enable"),
      cdp.command("DOM.enable"),
      cdp.command("Emulation.setDeviceMetricsOverride", {
        width: session.width,
        height: session.height,
        deviceScaleFactor: 1,
        mobile: false,
      }),
      cdp.command("Page.setInterceptFileChooserDialog", { enabled: true }),
      cdp.command("Fetch.enable", {
        handleAuthRequests: true,
        patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
      }),
      installPickers(cdp),
    ]);
  }

  /** Follow tabs as they open, change, and close. A tab the page opens becomes the one shown. */
  private async trackTabs(session: RunningBrowserSession): Promise<void> {
    const browser = session.browserCdp;
    browser.on("Target.targetCreated", (params) => {
      const tab = tabFromTargetInfo(params.targetInfo);
      if (!tab || session.tabs.has(tab.id)) return;
      session.tabs.set(tab.id, tab);
      this.emitTabs(session);
      void this.enqueue(session, () => this.activateTab(session, tab.id)).catch(() => {});
    });
    browser.on("Target.targetInfoChanged", (params) => {
      const info = tabFromTargetInfo(params.targetInfo);
      const tab = info && session.tabs.get(info.id);
      if (!info || !tab || (tab.url === info.url && tab.title === info.title)) return;
      tab.url = info.url;
      tab.title = info.title;
      this.emitTabs(session);
    });
    browser.on("Target.targetDestroyed", (params) => {
      const closed = typeof params.targetId === "string" ? session.tabs.get(params.targetId) : undefined;
      if (!closed) return;
      session.tabs.delete(closed.id);
      this.emitTabs(session);
      if (closed.id !== session.activeTab) return;
      const next = this.tabAfter(session, closed);
      void this.enqueue(session, async () => {
        if (next) await this.activateTab(session, next);
        // The new tab arrives through targetCreated, which shows it.
        else await browser.command("Target.createTarget", { url: "about:blank" });
      }).catch(() => {});
    });
    await browser.command("Target.setDiscoverTargets", { discover: true });
  }

  /** Show tab [id]: connect to it, move the live view over, and bring it forward. */
  private async activateTab(session: RunningBrowserSession, id: string): Promise<void> {
    if (session.activeTab === id || !session.tabs.has(id) || this.sessions.get(session.profile) !== session) return;
    const cdp = await CdpClient.connect(`ws://127.0.0.1:${session.port}/devtools/page/${id}`);
    // The old tab's connection is about to close, so nothing could answer its prompt.
    this.cancelPrompt(session);
    session.watch?.stop();
    const previous = session.cdp;
    const frameTargets = new Set<string>();
    session.cdp = cdp;
    session.activeTab = id;
    session.frameTargets = frameTargets;
    session.refFrames.clear();
    session.frameContexts.clear();
    previous.close();
    await this.setupPage(session, cdp, frameTargets);
    await session.browserCdp.command("Target.activateTarget", { targetId: id }).catch(() => {});
    const tab = session.tabs.get(id);
    if (tab) {
      session.url = tab.url;
      session.title = tab.title;
    }
    this.emitTabs(session);
    if (session.watch) await this.startScreencast(session, session.watch);
  }

  /** Show another open tab. */
  async switchTab(profileValue: string, id: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.touch(session);
    await this.enqueue(session, () => this.activateTab(session, id));
  }

  /** The tab to show once [closed] goes: the one that opened it, else the newest other tab. */
  private tabAfter(session: RunningBrowserSession, closed: BrowserTab): string | undefined {
    if (closed.openerId && session.tabs.has(closed.openerId)) return closed.openerId;
    return [...session.tabs.keys()].filter((id) => id !== closed.id).at(-1);
  }

  /**
   * Close a tab, moving the view off it first so nothing acts on a closed
   * page. The last tab stays open, since closing it would quit the browser.
   */
  async closeTab(profileValue: string, id: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.touch(session);
    await this.enqueue(session, async () => {
      const tab = session.tabs.get(id);
      if (!tab || session.tabs.size < 2) return;
      const next = this.tabAfter(session, tab);
      if (id === session.activeTab && next) await this.activateTab(session, next);
      await session.browserCdp.command("Target.closeTarget", { targetId: id });
    });
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
      seq: 0,
      unacked: new Map<number, number>(),
      acked: false,
    };
    watch.expiryTimer.unref?.();
    session.watch = watch;

    try {
      await this.startScreencast(session, watch);
    } catch (error) {
      this.unwatch(session.profile);
      throw error;
    }
    await this.refreshLocation(session).catch(() => {});
  }

  /** Stream the active tab to [watch]. A tab switch stops it and starts it again on the new tab. */
  private async startScreencast(session: RunningBrowserSession, watch: BrowserWatch): Promise<void> {
    const cdp = session.cdp;
    const unsubscribeFrame = cdp.on("Page.screencastFrame", (params) => {
      // Chrome pauses the cast until each frame is acknowledged.
      if (typeof params.sessionId === "number") {
        void cdp.command("Page.screencastFrameAck", { sessionId: params.sessionId })
          .catch(() => {});
      }
      if (typeof params.data !== "string" || !params.data) return;
      this.queueFrame(session, params.data);
    });
    const unsubscribeNavigation = cdp.on("Page.frameNavigated", () => {
      void this.refreshLocation(session).catch(() => {});
    });
    watch.stop = () => {
      unsubscribeFrame();
      unsubscribeNavigation();
      void cdp.command("Page.stopScreencast").catch(() => {});
    };
    await cdp.command("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: session.width,
      maxHeight: session.height,
      everyNthFrame: 1,
    });
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
   * A viewer has shown frame [seq], so every frame sent before it has arrived
   * too. Frees room for the next frame and sends it if one is waiting.
   */
  ackFrame(profileValue: string, seq: number): void {
    const session = this.sessions.get(normalizeBrowserProfile(profileValue));
    const watch = session?.watch;
    if (!session || !watch) return;
    watch.acked = true;
    for (const sent of watch.unacked.keys()) {
      if (sent <= seq) watch.unacked.delete(sent);
    }
    if (watch.sendTimer) clearTimeout(watch.sendTimer);
    watch.sendTimer = undefined;
    this.scheduleFrameSend(session, watch, 0);
  }

  /**
   * Hold the newest frame until it can go out. Frames that arrive meanwhile
   * replace it, so a slow link shows fewer frames rather than older ones.
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
    this.scheduleFrameSend(session, watch, 0);
  }

  private scheduleFrameSend(session: RunningBrowserSession, watch: BrowserWatch, delayMs: number): void {
    if (watch.sendTimer || !watch.pending) return;
    watch.sendTimer = setTimeout(() => {
      watch.sendTimer = undefined;
      if (session.watch === watch) this.sendPendingFrame(session, watch);
    }, Math.max(0, delayMs));
    watch.sendTimer.unref?.();
  }

  /**
   * Send the held frame once the rate floor has passed, viewers have room for
   * it, and the connection has drained. Otherwise wait for whichever is due.
   */
  private sendPendingFrame(session: RunningBrowserSession, watch: BrowserWatch): void {
    const frame = watch.pending;
    if (!frame) return;
    const now = Date.now();
    for (const [seq, sentAt] of watch.unacked) {
      if (now - sentAt >= FRAME_ACK_TIMEOUT_MS) watch.unacked.delete(seq);
    }
    const interval = now - session.lastInputAt < INTERACTIVE_WINDOW_MS
      ? INTERACTIVE_FRAME_INTERVAL_MS
      : FRAME_INTERVAL_MS;
    const paceWait = watch.lastSentAt + interval - now;
    if (paceWait > 0) {
      this.scheduleFrameSend(session, watch, paceWait);
      return;
    }
    if (watch.acked && watch.unacked.size >= MAX_UNACKED_FRAMES) {
      // An ack normally sends the frame first. This covers one that never comes.
      const oldest = Math.min(...watch.unacked.values());
      this.scheduleFrameSend(session, watch, oldest + FRAME_ACK_TIMEOUT_MS - now);
      return;
    }
    if (this.framesBackedUp()) {
      this.scheduleFrameSend(session, watch, CONGESTION_RETRY_MS);
      return;
    }
    watch.pending = undefined;
    watch.lastSentAt = now;
    watch.seq += 1;
    watch.unacked.set(watch.seq, now);
    const sent = { ...frame, seq: watch.seq };
    for (const listener of this.frameListeners) {
      try { listener(sent); } catch {}
    }
  }

  private async refreshLocation(session: RunningBrowserSession): Promise<void> {
    if (this.openDialog(session)) return;
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
      await this.dispatchInput(existing, "Page.navigate", { url });
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
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl && target.id);
      if (!page?.webSocketDebuggerUrl || !page.id) throw new Error("Browser did not create an interactive page.");
      const version = z.object({ webSocketDebuggerUrl: z.string() })
        .parse(await (await fetch(`http://127.0.0.1:${debuggingPort}/json/version`)).json());
      const browserCdp = await CdpClient.connect(version.webSocketDebuggerUrl);
      const cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
      const frameTargets = new Set<string>();
      const session: RunningBrowserSession = {
        profile,
        label: boundedLabel(labelValue, profile),
        ...(sessionId ? { sessionId } : {}),
        url,
        title: "",
        profileDir,
        process: processHandle,
        ...(display.process ? { displayProcess: display.process } : {}),
        port: debuggingPort,
        cdp,
        browserCdp,
        tabs: new Map([[page.id, { id: page.id, url: "about:blank", title: "" }]]),
        activeTab: page.id,
        blockedWaiters: new Set<() => void>(),
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        lastUsedAt: new Date().toISOString(),
        frameTargets,
        refFrames: new Map<string, PageFrame>(),
        frameContexts: new Map<string, number>(),
        inputQueue: Promise.resolve(),
        lastInputAt: 0,
      };
      processHandle.once("exit", () => {
        const current = this.sessions.get(profile);
        if (current === session) {
          if (current.idleTimer) clearTimeout(current.idleTimer);
          this.stopWatch(current);
          current.cdp.close();
          current.browserCdp.close();
          current.displayProcess?.kill("SIGTERM");
          this.sessions.delete(profile);
        }
      });
      await this.setupPage(session, cdp, frameTargets);
      await this.trackTabs(session);
      this.sessions.set(profile, session);
      await this.dispatchInput(session, "Page.navigate", { url });
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

  /**
   * Apply one viewer input. Inputs for a profile run strictly in arrival
   * order, so a fast typist's keys and a drag's moves never overtake each
   * other.
   */
  async phoneInput(profileValue: string, input: BrowserPhoneInput): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.touch(session);
    session.lastInputAt = Date.now();
    await this.enqueue(session, () => this.applyInput(session, input));
  }

  private enqueue<T>(session: RunningBrowserSession, work: () => Promise<T>): Promise<T> {
    const run = session.inputQueue.then(work);
    session.inputQueue = run.then(() => {}, () => {});
    return run;
  }

  private async applyInput(session: RunningBrowserSession, input: BrowserPhoneInput): Promise<void> {
    const clampX = (value: number) => Math.max(0, Math.min(session.width, Number(value)));
    const clampY = (value: number) => Math.max(0, Math.min(session.height, Number(value)));
    switch (input.action) {
      case "tap": {
        const x = clampX(input.x);
        const y = clampY(input.y);
        await this.dispatchInput(session, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await this.dispatchInput(session, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        break;
      }
      case "pointer": {
        const type = input.phase === "down" ? "mousePressed" : input.phase === "up" ? "mouseReleased" : "mouseMoved";
        await this.dispatchInput(session, "Input.dispatchMouseEvent", {
          type,
          x: clampX(input.x),
          y: clampY(input.y),
          button: input.button,
          buttons: input.buttons,
          clickCount: input.clickCount,
          modifiers: input.modifiers,
        });
        break;
      }
      case "keyboard": {
        const modifiers = input.modifiers;
        // A key typed with Ctrl or Meta is a shortcut, not text.
        const shortcut = (modifiers & 6) !== 0;
        const key = input.key || NAMED_KEYS[input.code] || input.text || "";
        // Enter types "\r" on a real keyboard, and forms submit on that keypress.
        const typed = input.text ?? (key === "Enter" ? "\r" : undefined);
        const text = shortcut ? undefined : typed;
        const command = input.phase === "down" ? macEditingCommand(key, modifiers) : undefined;
        await this.dispatchInput(session, "Input.dispatchKeyEvent", {
          type: input.phase === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
          key,
          code: input.code,
          windowsVirtualKeyCode: virtualKeyCode(input.code, key),
          modifiers,
          location: keyLocation(input.code),
          autoRepeat: input.repeat,
          ...(text && input.phase === "down" ? { text, unmodifiedText: text } : {}),
          ...(command ? { commands: [command] } : {}),
        });
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
        await this.dispatchInput(session, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: input.x === undefined ? session.width / 2 : clampX(input.x),
          y: input.y === undefined ? session.height / 2 : clampY(input.y),
          deltaX: Math.max(-5000, Math.min(5000, Number(input.deltaX || 0))),
          deltaY: Math.max(-5000, Math.min(5000, Number(input.deltaY))),
        });
        break;
      case "navigate":
        await this.dispatchInput(session, "Page.navigate", { url: normalizeBrowserUrl(input.url) });
        break;
      case "reload":
        await this.dispatchInput(session, "Page.reload", { ignoreCache: false });
        break;
      case "back":
        await this.historyStep(session, -1);
        break;
      case "forward":
        await this.historyStep(session, 1);
        break;
    }
  }

  /**
   * Whether the focused element takes typing, so a phone viewer can open
   * its keyboard when a page field gets focus and close it otherwise.
   */
  async focusState(profileValue: string): Promise<BrowserFocusState> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    // Read focus only after the input that may have moved it has run.
    await session.inputQueue;
    let kind = readStringResult(await session.cdp.command("Runtime.evaluate", {
      expression: FOCUS_EXPRESSION,
      returnByValue: true,
    }));
    if (kind === "frame") {
      kind = "none";
      for (const target of session.frameTargets) {
        const result = await session.cdp.command("Runtime.evaluate", {
          expression: FRAME_FOCUS_EXPRESSION,
          returnByValue: true,
        }, target).catch(() => ({}));
        const frameKind = readStringResult(result);
        if (frameKind && frameKind !== "unfocused") {
          kind = frameKind;
          break;
        }
      }
    }
    switch (kind) {
      case "text":
      case "password":
      case "email":
      case "number":
      case "tel":
      case "url":
      case "multiline":
        return { editable: true, inputKind: kind };
      default:
        return { editable: false };
    }
  }

  /**
   * Lists the page's text and visible controls, including those inside
   * embedded frames, and tags each control with a ref for click and type.
   */
  async snapshot(profileValue: string): Promise<BrowserSnapshot> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.touch(session);
    const dialog = this.openDialog(session);
    if (dialog) {
      return {
        profile: session.profile,
        url: session.url,
        title: session.title,
        text: `The page is showing a ${dialog.dialogType} dialog and is paused until it is answered: "${dialog.message}". `
          + "The user answers it in the phone browser.",
        elements: [],
        frames: [],
      };
    }
    const frames = await this.listFrames(session);
    const boxes = new Map<string, FrameBox | undefined>();
    session.refFrames.clear();
    const elements: BrowserSnapshotElement[] = [];
    const listedFrames: BrowserSnapshot["frames"] = [];
    let text = "";
    let url = session.url;
    let title = session.title;
    for (const frame of frames.values()) {
      const top = !frame.parentFrameId;
      if (!top && !(await this.frameBox(session, frames, frame, boxes).catch(() => undefined))) continue;
      const start = elements.length;
      const limit = Math.min(SNAPSHOT_FRAME_ELEMENTS, SNAPSHOT_TOTAL_ELEMENTS - start);
      const textLimit = Math.min(top ? SNAPSHOT_PAGE_TEXT : SNAPSHOT_FRAME_TEXT, Math.max(0, SNAPSHOT_TOTAL_TEXT - text.length));
      let result: z.infer<typeof snapshotFrameSchema>;
      try {
        const serialized = readStringResult(await this.evaluateInFrame(session, frame, snapshotExpression(start, limit, textLimit)));
        if (!serialized) throw new Error("Browser page could not be inspected.");
        result = snapshotFrameSchema.parse(JSON.parse(serialized));
      } catch (error) {
        // A frame can navigate away or detach mid-snapshot. Only the page itself must answer.
        if (top) throw error;
        continue;
      }
      let frameNumber: number | undefined;
      if (top) {
        url = result.url;
        title = result.title;
        text = result.text;
      } else if (result.elements.length || result.text.trim()) {
        frameNumber = listedFrames.length + 1;
        listedFrames.push({ frame: frameNumber, url: result.url });
        text += `\n\n[Frame ${frameNumber}: ${result.url}]\n${result.text}`;
      } else {
        continue;
      }
      for (const element of result.elements) {
        session.refFrames.set(element.ref, frame);
        elements.push(frameNumber ? { ...element, frame: frameNumber } : element);
      }
    }
    session.url = url || session.url;
    return { profile: session.profile, url, title, text: text.slice(0, SNAPSHOT_TOTAL_TEXT), elements, frames: listedFrames };
  }

  async click(profileValue: string, ref: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    this.assertNoDialog(session);
    const point = await this.elementPoint(session, ref, false);
    await this.phoneInput(session.profile, { action: "tap", x: point.x, y: point.y });
  }

  async type(profileValue: string, ref: string, text: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    if (text.length > 16_384) throw new Error("Browser text input is too large.");
    this.assertNoDialog(session);
    const point = await this.elementPoint(session, ref, true);
    // Script focus inside a cross-origin frame does not move keyboard focus to that
    // frame, so a real tap does it. The page's own fields only need the script focus.
    if (point.frame) {
      await this.phoneInput(session.profile, { action: "tap", x: point.x, y: point.y });
      await this.waitForFocus(session, point.frame, ref);
    }
    await this.pressKey(session, "CTRL+A");
    await session.cdp.command("Input.insertText", { text });
  }

  /** Taps a point in the viewport, for elements a snapshot cannot list. */
  async tap(profileValue: string, x: number, y: number): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > session.width || y > session.height) {
      throw new Error(`Tap coordinates must be inside the ${session.width}x${session.height} viewport.`);
    }
    this.assertNoDialog(session);
    await this.phoneInput(session.profile, { action: "tap", x, y });
  }

  /**
   * The page's frames in document order, keyed by frame ID. Chrome reports
   * each out-of-process frame's subtree through that frame's own session.
   */
  private async listFrames(session: RunningBrowserSession): Promise<Map<string, PageFrame>> {
    const found = new Map<string, Omit<PageFrame, "target">>();
    const ownRoots = new Map<string, string>();
    const visit = (tree: unknown, target?: string, root = true): void => {
      if (!isRecord(tree) || !isRecord(tree.frame) || typeof tree.frame.id !== "string") return;
      const { id, parentId, url } = tree.frame;
      const known = found.get(id);
      found.set(id, {
        frameId: id,
        parentFrameId: typeof parentId === "string" ? parentId : known?.parentFrameId,
        url: typeof url === "string" ? url : known?.url ?? "",
      });
      if (target && root) ownRoots.set(id, target);
      for (const child of unknownArray(tree.childFrames)) visit(child, target, false);
    };
    visit((await session.cdp.command("Page.getFrameTree")).frameTree);
    for (const target of [...session.frameTargets]) {
      try {
        visit((await session.cdp.command("Page.getFrameTree", {}, target)).frameTree, target);
      } catch {
        // Detached between listing and asking.
      }
    }
    // A frame belongs to the nearest out-of-process frame at or above it.
    const targetOf = (frameId: string): string | undefined => {
      for (let id: string | undefined = frameId, depth = 0; id && depth < 64; depth++) {
        const own = ownRoots.get(id);
        if (own) return own;
        id = found.get(id)?.parentFrameId;
      }
      return undefined;
    };
    const children = new Map<string, string[]>();
    let rootId: string | undefined;
    for (const frame of found.values()) {
      if (!frame.parentFrameId) rootId ??= frame.frameId;
      else children.set(frame.parentFrameId, [...children.get(frame.parentFrameId) ?? [], frame.frameId]);
    }
    const ordered = new Map<string, PageFrame>();
    const walk = (frameId: string): void => {
      const frame = found.get(frameId);
      if (!frame || ordered.has(frameId)) return;
      const target = targetOf(frameId);
      ordered.set(frameId, { ...frame, ...(target ? { target } : {}) });
      for (const child of children.get(frameId) ?? []) walk(child);
    };
    if (rootId) walk(rootId);
    return ordered;
  }

  /**
   * Runs [use] with the execution context for agent scripts in [frame]: the
   * page's own context for the top frame, otherwise an isolated world, which
   * shares the DOM but not page scripts. A frame that navigated loses its
   * world, so a stale one is replaced once.
   */
  private async withFrameContext<T>(
    session: RunningBrowserSession,
    frame: PageFrame,
    use: (contextId: number | undefined) => Promise<T>,
  ): Promise<T> {
    if (!frame.parentFrameId) return await use(undefined);
    for (let attempt = 0; ; attempt++) {
      let contextId = session.frameContexts.get(frame.frameId);
      if (contextId === undefined) {
        const created = await session.cdp.command("Page.createIsolatedWorld", { frameId: frame.frameId, worldName: "socketagent" }, frame.target);
        if (typeof created.executionContextId !== "number") throw new Error("Browser frame could not be inspected.");
        contextId = created.executionContextId;
        session.frameContexts.set(frame.frameId, contextId);
      }
      try {
        return await use(contextId);
      } catch (error) {
        session.frameContexts.delete(frame.frameId);
        if (attempt > 0) throw error;
      }
    }
  }

  private async evaluateInFrame(session: RunningBrowserSession, frame: PageFrame, expression: string): Promise<JsonRecord> {
    return await this.withFrameContext(session, frame, async (contextId) => {
      const result = await session.cdp.command("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true, ...(contextId === undefined ? {} : { contextId }),
      }, frame.target);
      if (contextId !== undefined && isRecord(result.exceptionDetails)) {
        throw new Error(runtimeExceptionDescription(result) || "Browser frame script failed.");
      }
      return result;
    });
  }

  /**
   * Where [frame]'s content sits in the page viewport, found by adding up the
   * offset of each frame element above it. Undefined when it or any frame
   * above it is hidden. [cache] is shared across one snapshot.
   */
  private async frameBox(
    session: RunningBrowserSession,
    frames: Map<string, PageFrame>,
    frame: PageFrame,
    cache = new Map<string, FrameBox | undefined>(),
  ): Promise<FrameBox | undefined> {
    if (!frame.parentFrameId) return { x: 0, y: 0, width: session.width, height: session.height };
    if (cache.has(frame.frameId)) return cache.get(frame.frameId);
    const parent = frames.get(frame.parentFrameId);
    let box: FrameBox | undefined;
    const parentBox = parent ? await this.frameBox(session, frames, parent, cache) : undefined;
    if (parent && parentBox) {
      const owner = await session.cdp.command("DOM.getFrameOwner", { frameId: frame.frameId }, parent.target);
      if (typeof owner.backendNodeId === "number") {
        const backendNodeId = owner.backendNodeId;
        const local = await this.withFrameContext(session, parent, async (contextId) => {
          const resolved = await session.cdp.command("DOM.resolveNode", {
            backendNodeId, ...(contextId === undefined ? {} : { executionContextId: contextId }),
          }, parent.target);
          const objectId = isRecord(resolved.object) && typeof resolved.object.objectId === "string" ? resolved.object.objectId : "";
          if (!objectId) return null;
          try {
            const result = await session.cdp.command("Runtime.callFunctionOn", {
              objectId, functionDeclaration: FRAME_BOX_FUNCTION, returnByValue: true,
            }, parent.target);
            return frameBoxSchema.parse(JSON.parse(readStringResult(result) || "null"));
          } finally {
            void session.cdp.command("Runtime.releaseObject", { objectId }, parent.target).catch(() => {});
          }
        });
        if (local && local.width > 0 && local.height > 0) {
          box = { x: parentBox.x + local.x, y: parentBox.y + local.y, width: local.width, height: local.height };
        }
      }
    }
    cache.set(frame.frameId, box);
    return box;
  }

  /**
   * Scrolls a snapshot element into view and returns its center in page
   * viewport coordinates, plus the embedded frame holding it, if any.
   */
  private async elementPoint(
    session: RunningBrowserSession,
    ref: string,
    forTyping: boolean,
  ): Promise<{ x: number; y: number; frame?: PageFrame }> {
    const safeRef = String(ref).trim();
    if (!/^sa-[1-9][0-9]{0,3}$/.test(safeRef)) throw new Error("Browser element reference is invalid. Refresh the snapshot.");
    const unavailable = new Error("Browser element is no longer available. Refresh the snapshot.");
    const tagged = session.refFrames.get(safeRef);
    if (!tagged) throw unavailable;
    // Frame IDs are stable, but the session hosting a frame can change as it navigates.
    const frames = tagged.parentFrameId ? await this.listFrames(session) : undefined;
    const frame = frames ? frames.get(tagged.frameId) : tagged;
    if (!frame) throw unavailable;
    const serialized = readStringResult(await this.evaluateInFrame(session, frame, elementExpression(safeRef, forTyping)));
    if (!serialized) throw unavailable;
    const point = elementPointSchema.parse(JSON.parse(serialized));
    if ("secret" in point) throw new Error("The agent cannot type into password fields. Open the protected phone browser.");
    if (!frames) return point;
    // Scrolling inside a cross-site frame scrolls the page around it from another
    // process, which finishes later. Measure until the position holds still.
    let previous: { x: number; y: number } | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const box = await this.frameBox(session, frames, frame);
      if (!box) throw new Error("The frame holding this element is hidden. Refresh the snapshot.");
      const center = attempt === 0
        ? point
        : z.object({ x: z.number(), y: z.number() }).parse(JSON.parse(
          readStringResult(await this.evaluateInFrame(session, frame, elementCenterExpression(safeRef))) || "null",
        ));
      const current = { x: box.x + center.x, y: box.y + center.y };
      if (previous && previous.x === current.x && previous.y === current.y) return { ...current, frame };
      previous = current;
      await wait(50);
    }
    throw new Error("The browser element kept moving. Refresh the snapshot and retry.");
  }

  /**
   * Waits for keyboard focus to reach a frame element after a tap. Focus
   * crosses into another renderer process asynchronously, and typed text sent
   * before it lands goes nowhere.
   */
  private async waitForFocus(session: RunningBrowserSession, frame: PageFrame, ref: string): Promise<void> {
    const expression = `document.hasFocus() && document.activeElement?.getAttribute('data-socketagent-ref') === ${JSON.stringify(ref.trim())}`;
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await this.evaluateInFrame(session, frame, expression);
      if (isRecord(result.result) && result.result.value === true) return;
      await wait(50);
    }
    throw new Error("The browser field did not take focus. Refresh the snapshot and retry.");
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

  /**
   * Runs in the input queue, so a viewer's paste shortcut sent right after
   * this lands on the new clipboard contents.
   */
  async writeClipboard(profileValue: string, text: string): Promise<void> {
    const session = this.require(normalizeBrowserProfile(profileValue));
    if (text.length > 65_536) throw new Error("Browser clipboard text is too large.");
    await this.enqueue(session, () => this.writeClipboardNow(session, text));
  }

  private async writeClipboardNow(session: RunningBrowserSession, text: string): Promise<void> {
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
    session.browserCdp.close();
    await stopChildProcess(session.process);
    await stopChildProcess(session.displayProcess);
    fs.rmSync(path.join(session.profileDir, "SocketAgent Uploads"), { recursive: true, force: true });
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
    await this.refreshLocation(session);
    const url = session.url;
    return {
      profile: session.profile,
      label: session.label,
      running: true,
      sessionId: session.sessionId,
      url,
      title: session.title,
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
    await this.dispatchInput(session, "Input.dispatchKeyEvent", { type: "keyDown", ...definition });
    await this.dispatchInput(session, "Input.dispatchKeyEvent", { type: "keyUp", ...definition });
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
    const entries = unknownArray(result.entries);
    const target = entries[currentIndex + delta];
    if (isRecord(target) && typeof target.id === "number") {
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
        const targets = z.array(z.object({
          id: z.string().optional(), type: z.string().optional(), url: z.string().optional(),
          webSocketDebuggerUrl: z.string().optional(),
        })).parse(await response.json());
        if (targets.some((target) => target.type === "page" && target.webSocketDebuggerUrl)) return targets;
      } catch {}
      await wait(100);
    }
    throw new Error("Browser page did not become available within 15 seconds.");
  }
}

export const browserSessionManager = new BrowserSessionManager();
