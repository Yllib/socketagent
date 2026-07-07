#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const path = require("path");

const serverDir = path.resolve(__dirname, "..");
const envPath = path.join(serverDir, ".env");

function readEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return env;
}

const env = { ...readEnv(envPath), ...process.env };
const port = Number(env.PORT || 8085);
const token = env.AUTH_TOKEN || "";
const [commandArg, ...rest] = process.argv.slice(2);

function usage() {
  console.error("Usage: socketagent phone-adb devices");
  console.error("       socketagent phone-adb pair <pair-port> <pair-code>");
  console.error("       socketagent phone-adb connect <connect-port>");
  console.error("       socketagent phone-adb shell <command>");
  console.error("       socketagent phone-adb adb <adb-args...>");
  console.error("       socketagent phone-adb install <apk-path> [install-args...]");
  console.error("       socketagent phone-adb open-apk <apk-path>");
  console.error("       socketagent phone-adb logcat [--seconds N] [--max-bytes N] [logcat-args...]");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

let bodyObject;
let streamResponse = false;
const command = (commandArg || "").toLowerCase();

if (command === "devices" || command === "") {
  bodyObject = { command: "devices" };
} else if (command === "shell") {
  if (rest.length === 0) {
    usage();
    process.exit(2);
  }
  bodyObject = { command: "shell", shellCommand: rest.join(" ") };
} else if (command === "pair") {
  if (rest.length < 2) {
    usage();
    process.exit(2);
  }
  bodyObject = {
    command: "pair",
    pairPort: parsePositiveInt(rest[0], 0),
    code: rest[1],
  };
} else if (command === "connect") {
  if (rest.length < 1) {
    usage();
    process.exit(2);
  }
  bodyObject = {
    command: "connect",
    connectPort: parsePositiveInt(rest[0], 0),
  };
} else if (command === "adb" || command === "command") {
  if (rest.length === 0) {
    usage();
    process.exit(2);
  }
  bodyObject = { command: "adb", args: rest };
} else if (command === "install") {
  if (rest.length === 0) {
    usage();
    process.exit(2);
  }
  bodyObject = {
    command: "install",
    filePath: path.resolve(rest[0]),
    args: rest.slice(1),
    timeoutSeconds: 600,
  };
} else if (command === "open-apk" || command === "open_apk" || command === "stage-apk" || command === "stage_apk") {
  if (rest.length === 0) {
    usage();
    process.exit(2);
  }
  bodyObject = {
    command: "open_apk",
    filePath: path.resolve(rest[0]),
    timeoutSeconds: 600,
  };
} else if (command === "logcat") {
  let seconds = parsePositiveInt(process.env.SOCKETAGENT_PHONE_ADB_LOGCAT_SECONDS, 30);
  let maxBytes = parsePositiveInt(process.env.SOCKETAGENT_PHONE_ADB_LOGCAT_MAX_BYTES, 4 * 1024 * 1024);
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if ((arg === "--seconds" || arg === "--duration") && i + 1 < rest.length) {
      seconds = parsePositiveInt(rest[++i], seconds);
    } else if (arg === "--max-bytes" && i + 1 < rest.length) {
      maxBytes = parsePositiveInt(rest[++i], maxBytes);
    } else {
      args.push(arg);
    }
  }
  bodyObject = {
    command: "logcat",
    args,
    timeoutSeconds: seconds,
    maxBytes,
    stream: true,
  };
  streamResponse = true;
} else {
  usage();
  process.exit(2);
}

const body = JSON.stringify(bodyObject);

const req = http.request(
  {
    hostname: "127.0.0.1",
    port,
    path: `/phone-adb?token=${encodeURIComponent(token)}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  },
  (res) => {
    if (streamResponse) {
      res.setEncoding("utf8");
      res.on("data", (chunk) => { process.stdout.write(chunk); });
      res.on("end", () => {
        process.exit(res.statusCode && res.statusCode >= 400 ? 1 : 0);
      });
      return;
    }

    let raw = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { raw += chunk; });
    res.on("end", () => {
      try {
        const parsed = JSON.parse(raw || "{}");
        if (!parsed.success) {
          console.error(parsed.error || `HTTP ${res.statusCode}`);
          process.exit(1);
        }
        const result = parsed.result || {};
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.message) {
          const stream = result.ok === false ? process.stderr : process.stdout;
          stream.write(`${result.message}\n`);
        }
        process.exit(result.ok === false ? 1 : 0);
      } catch (err) {
        console.error(raw || err.message);
        process.exit(1);
      }
    });
  },
);

req.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
req.write(body);
req.end();
