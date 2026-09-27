#!/usr/bin/env node
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
 * Phase 0 probe for the Codex App Server protocol.
 *
 * This script intentionally does not import SocketAgent server code. It is a
 * standalone smoke test for:
 *   initialize -> thread/start -> turn/start -> turn/steer -> notifications
 *
 * Usage:
 *   node server/scripts/probe-codex-app-server.js
 *   node server/scripts/probe-codex-app-server.js --cwd /path/to/repo
 *   node server/scripts/probe-codex-app-server.js --prompt "..."
 *   node server/scripts/probe-codex-app-server.js --steer "..."
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** @param {NodeJS.ProcessEnv} env */
function pathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
}

/** @param {NodeJS.ProcessEnv} env */
function candidateCodexDirs(env) {
  const home = env.HOME || os.homedir();
  if (process.platform !== "win32") {
    return [
      path.join(home, ".local", "share", "socketagent", "npm-global", "bin"),
      path.join(home, ".local", "bin"),
    ];
  }
  const appData = env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
  const localAppData = env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
  return [
    appData && path.join(appData, "npm"),
    localAppData && path.join(localAppData, "npm"),
    localAppData && path.join(localAppData, "Programs", "nodejs"),
    env.ProgramFiles && path.join(env.ProgramFiles, "nodejs"),
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "nodejs"),
  ].filter((value) => typeof value === "string" && value.length > 0);
}

/** @param {string[]} args */
function resolveCodexSpawn(args) {
  const env = { ...process.env };
  const key = pathKey(env);
  const parts = (env[key] || "").split(path.delimiter).filter(Boolean);
  for (const dir of candidateCodexDirs(env)) {
    if (fs.existsSync(dir) && !parts.some((part) => path.resolve(part).toLowerCase() === path.resolve(dir).toLowerCase())) {
      parts.push(dir);
    }
  }
  env[key] = parts.join(path.delimiter);
  if (key !== "PATH") env.PATH = env[key];

  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
  for (const dir of parts) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return {
          command: candidate,
          args,
          env,
          shell: process.platform === "win32" && !/\.(?:exe|com)$/i.test(candidate),
        };
      }
    }
  }
  return { command: "codex", args, env, shell: process.platform === "win32" };
}

/** @param {string} name @param {string} fallback */
function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const cwd = path.resolve(argValue("--cwd", process.cwd()));
const prompt = argValue(
  "--prompt",
  "Use a shell command to sleep for 8 seconds, then print APP_SERVER_PROBE_DONE. If I send another message while you are working, acknowledge it in your final answer."
);
const steerText = argValue(
  "--steer",
  "Steering probe: after the sleep finishes, also mention APP_SERVER_STEER_RECEIVED."
);
const steerDelayMs = Number(argValue("--steer-delay-ms", "2000"));
const timeoutMs = Number(argValue("--timeout-ms", "60000"));
const verbose = process.argv.includes("--verbose");
const experimentalRawEvents = process.argv.includes("--raw-events");

let nextId = 1;
/** @type {Map<number, {method: string, resolve(value: unknown): void, reject(error: Error): void}>} */
const pending = new Map();
/** @type {string | null} */
let threadId = null;
/** @type {string | null} */
let turnId = null;
let steerSent = false;
let sawCompleted = false;
/** @type {NodeJS.Timeout | null} */
let watchdog = null;
/** @type {NodeJS.Timeout | null} */
let shutdownTimer = null;

const codex = resolveCodexSpawn(["app-server", "--listen", "stdio://"]);
const child = spawn(codex.command, codex.args, {
  cwd,
  env: codex.env,
  shell: codex.shell,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (/** @type {string} */ chunk) => {
  for (const line of chunk.split(/\r?\n/)) {
    if (line.trim()) console.error(`[app-server stderr] ${line}`);
  }
});

child.on("exit", (code, signal) => {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  if (!sawCompleted) {
    console.error(`[probe] app-server exited before completion code=${code} signal=${signal}`);
    process.exitCode = 1;
  }
});

/** @param {string} method @param {Record<string, unknown>} params @returns {Promise<unknown>} */
function send(method, params) {
  const id = nextId++;
  const msg = { id, method, params };
  const line = JSON.stringify(msg);
  console.log(`[client ->] ${method}#${id}`);
  child.stdin.write(line + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject });
  });
}

/** @param {Error} error */
function rejectAll(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}

/** @param {string} method @param {unknown} params */
function onNotification(method, params) {
  const data = isRecord(params) ? params : {};
  const turn = isRecord(data.turn) ? data.turn : undefined;
  const thread = isRecord(data.thread) ? data.thread : undefined;
  const item = isRecord(data.item) ? data.item : undefined;
  /** @type {Record<string, unknown>} */
  const summary = {};
  if (data.threadId) summary.threadId = data.threadId;
  if (data.turnId) summary.turnId = data.turnId;
  if (item?.type) summary.itemType = item.type;
  if (data.delta) summary.delta = String(data.delta).slice(0, 120);
  if (turn?.id) summary.turnId = turn.id;
  if (thread?.id) summary.threadId = thread.id;
  console.log(`[notify] ${method} ${JSON.stringify(summary)}`);
  if (verbose) {
    console.log(`[notify:full] ${method} ${JSON.stringify(params)}`);
  }

  if (method === "thread/started" && typeof thread?.id === "string") {
    threadId = thread.id;
  }
  if (method === "turn/started" && typeof turn?.id === "string") {
    turnId = turn.id;
    if (!steerSent) {
      steerSent = true;
      setTimeout(() => {
        if (!threadId || !turnId) return;
        send("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: steerText, text_elements: [] }],
        })
          .then((result) => {
            console.log(`[probe] turn/steer succeeded: ${JSON.stringify(result).slice(0, 500)}`);
          })
          .catch((/** @type {unknown} */ err) => {
            console.error(`[probe] turn/steer failed: ${err instanceof Error ? err.message : String(err)}`);
          });
      }, steerDelayMs);
    }
  }
  if (method === "turn/completed") {
    sawCompleted = true;
    console.log("[probe] turn completed; shutting down app-server");
    if (watchdog) clearTimeout(watchdog);
    child.stdin.end();
    child.kill("SIGTERM");
    shutdownTimer = setTimeout(() => {
      console.error("[probe] app-server did not exit after SIGTERM; sending SIGKILL");
      child.kill("SIGKILL");
    }, 3000);
  }
}

let stdoutTail = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (/** @type {string} */ chunk) => {
  stdoutTail += chunk;
  const lines = stdoutTail.split("\n");
  stdoutTail = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    /** @type {unknown} */
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.error(`[probe] failed to parse line: ${line.slice(0, 300)}`);
      continue;
    }

    if (!isRecord(msg)) continue;
    if (Object.prototype.hasOwnProperty.call(msg, "id")) {
      const pendingRequest = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (!pendingRequest) {
        console.log(`[server ->] response#${msg.id} with no pending request`);
        continue;
      }
      if (typeof msg.id === "number") pending.delete(msg.id);
      if (msg.error) {
        pendingRequest.reject(new Error(JSON.stringify(msg.error)));
      } else {
        console.log(`[server ->] ${pendingRequest.method}#${msg.id} ok`);
        pendingRequest.resolve(msg.result);
      }
      continue;
    }

    if (typeof msg.method === "string") {
      onNotification(msg.method, msg.params);
    } else {
      console.log(`[server ->] ${line.slice(0, 500)}`);
    }
  }
});

async function main() {
  watchdog = setTimeout(() => {
    const err = new Error(`probe timed out after ${timeoutMs}ms`);
    rejectAll(err);
    child.kill("SIGTERM");
    console.error(`[probe] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }, timeoutMs);

  try {
    const init = await send("initialize", {
      clientInfo: {
        name: "socketagent-app-server-probe",
        title: "SocketAgent App Server Probe",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    console.log(`[probe] initialized: ${isRecord(init) ? init.userAgent || "unknown userAgent" : "unknown userAgent"}`);

    const started = await send("thread/start", {
      cwd,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      experimentalRawEvents,
      persistExtendedHistory: false,
    });
    if (!isRecord(started) || !isRecord(started.thread) || typeof started.thread.id !== "string") throw new Error("Invalid thread/start response");
    threadId = started.thread.id;
    console.log(`[probe] threadId=${threadId}`);

    const turn = await send("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd,
    });
    if (!isRecord(turn) || !isRecord(turn.turn) || typeof turn.turn.id !== "string") throw new Error("Invalid turn/start response");
    turnId = turn.turn.id;
    console.log(`[probe] turnId=${turnId}`);
  } catch (err) {
    if (watchdog) clearTimeout(watchdog);
    console.error(`[probe] failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    child.kill("SIGTERM");
    process.exitCode = 1;
  }
}

main();
