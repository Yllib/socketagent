#!/usr/bin/env node
/**
 * Phase 0 probe for the Codex App Server protocol.
 *
 * This script intentionally does not import SocketClaude server code. It is a
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
const path = require("path");

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

let nextId = 1;
const pending = new Map();
let threadId = null;
let turnId = null;
let steerSent = false;
let sawCompleted = false;
let watchdog = null;
let shutdownTimer = null;

const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
  cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
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

function rejectAll(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}

function onNotification(method, params) {
  const summary = {};
  if (params && typeof params === "object") {
    if (params.threadId) summary.threadId = params.threadId;
    if (params.turnId) summary.turnId = params.turnId;
    if (params.item?.type) summary.itemType = params.item.type;
    if (params.delta) summary.delta = String(params.delta).slice(0, 120);
    if (params.turn?.id) summary.turnId = params.turn.id;
    if (params.thread?.id) summary.threadId = params.thread.id;
  }
  console.log(`[notify] ${method} ${JSON.stringify(summary)}`);

  if (method === "thread/started" && params?.thread?.id) {
    threadId = params.thread.id;
  }
  if (method === "turn/started" && params?.turn?.id) {
    turnId = params.turn.id;
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
          .catch((err) => {
            console.error(`[probe] turn/steer failed: ${err.message}`);
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
child.stdout.on("data", (chunk) => {
  stdoutTail += chunk;
  const lines = stdoutTail.split("\n");
  stdoutTail = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.error(`[probe] failed to parse line: ${line.slice(0, 300)}`);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(msg, "id")) {
      const pendingRequest = pending.get(msg.id);
      if (!pendingRequest) {
        console.log(`[server ->] response#${msg.id} with no pending request`);
        continue;
      }
      pending.delete(msg.id);
      if (msg.error) {
        pendingRequest.reject(new Error(JSON.stringify(msg.error)));
      } else {
        console.log(`[server ->] ${pendingRequest.method}#${msg.id} ok`);
        pendingRequest.resolve(msg.result);
      }
      continue;
    }

    if (msg.method) {
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
    console.error(`[probe] ${err.message}`);
    process.exitCode = 1;
  }, timeoutMs);

  try {
    const init = await send("initialize", {
      clientInfo: {
        name: "socketclaude-app-server-probe",
        title: "SocketClaude App Server Probe",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    console.log(`[probe] initialized: ${init.userAgent || "unknown userAgent"}`);

    const started = await send("thread/start", {
      cwd,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    threadId = started.thread?.id;
    console.log(`[probe] threadId=${threadId}`);

    const turn = await send("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd,
    });
    turnId = turn.turn?.id;
    console.log(`[probe] turnId=${turnId}`);
  } catch (err) {
    if (watchdog) clearTimeout(watchdog);
    console.error(`[probe] failed: ${err.stack || err.message || err}`);
    child.kill("SIGTERM");
    process.exitCode = 1;
  }
}

main();
