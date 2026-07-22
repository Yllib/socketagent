const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const result = predicate();
      if (result) return resolve(result);
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error("Timed out waiting for durable monitor"));
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

test("Monitor worker survives its server parent and restores exact pending output", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-monitor-restart-"));
  const sessionId = `restart-session-${Date.now()}`;
  const fixture = path.join(__dirname, "fixtures", "start-monitor-and-exit.js");
  const started = spawnSync(process.execPath, [fixture], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      SOCKETAGENT_DATA_DIR: dataDir,
      SOCKETAGENT_MONITOR_LAUNCH_MODE: "direct",
      TEST_SESSION_ID: sessionId,
      TEST_MONITOR_COMMAND: "printf 'before\\n'; sleep 1.2; printf 'after\\n'; sleep 0.2",
      TEST_PARENT_EXIT_DELAY_MS: "700",
    },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(started.status, 0, started.stderr);
  const taskId = started.stdout.trim();
  assert.match(taskId, /^monitor-/);

  process.env.SOCKETAGENT_DATA_DIR = dataDir;
  process.env.SOCKETAGENT_MONITOR_LAUNCH_MODE = "direct";
  const {
    getDurableMonitorRecord,
    readDurableMonitorSlice,
  } = require("../dist/durable-monitor-store");
  const { restoreAppMonitors } = require("../dist/app-tool-handlers");

  const firstRecord = getDurableMonitorRecord(taskId);
  assert.ok(firstRecord, "durable record should survive the server parent");
  assert.ok(firstRecord.phoneOffset > 0, "the old server should checkpoint its live delivery");
  assert.match(readDurableMonitorSlice(firstRecord, 0).content, /before/);
  assert.doesNotMatch(readDurableMonitorSlice(firstRecord, 0).content, /after/);
  await waitFor(() => {
    const record = getDurableMonitorRecord(taskId);
    if (!record) return false;
    return readDurableMonitorSlice(record, 0).content.includes("after");
  });

  const sent = [];
  const history = [];
  const injected = [];
  const restored = restoreAppMonitors((record) => ({
    getSessionId: () => record.sessionId,
    getCwd: () => record.cwd,
    getBackend: () => record.backend,
    send: (message) => sent.push(message),
    appendHistory: (entry) => {
      history.push(entry);
      return { ...entry, entryId: "monitor-entry", sessionSeq: 1, revision: history.length };
    },
    getTtsEngine: () => "system",
    getKokoroVoice: () => "",
    getKokoroSpeed: () => 1,
    isRunning: () => true,
    injectMessage: async (text) => { injected.push(text); },
  }));
  assert.equal(restored, 1);

  await waitFor(() => sent.find((message) => message.type === "task_notification"));
  const phoneOutput = sent
    .filter((message) => message.type === "monitor_output")
    .map((message) => message.content)
    .join("\n");
  assert.doesNotMatch(phoneOutput, /before/);
  assert.match(phoneOutput, /after/);
  assert.match(history.at(-1)?.content || "", /before[\s\S]*after/);
  assert.equal(injected.length, 1);
  assert.match(injected[0], /before[\s\S]*after/);
  assert.equal(getDurableMonitorRecord(taskId), null);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Linux monitor runs in a user service outside the SocketAgent server cgroup", async (t) => {
  if (process.platform !== "linux") return t.skip("systemd user services are Linux-only");
  const systemd = spawnSync("systemctl", ["--user", "is-system-running"], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (systemd.status !== 0) return t.skip("no running systemd user manager");

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-monitor-systemd-"));
  const fixture = path.join(__dirname, "fixtures", "start-monitor-and-exit.js");
  const started = spawnSync(process.execPath, [fixture], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      SOCKETAGENT_DATA_DIR: dataDir,
      SOCKETAGENT_MONITOR_LAUNCH_MODE: "",
      TEST_SESSION_ID: `systemd-session-${Date.now()}`,
    },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(started.status, 0, started.stderr);
  const taskId = started.stdout.trim();
  assert.match(taskId, /^monitor-/);
  const recordPath = path.join(dataDir, "monitors", "records", `${taskId}.json`);

  const completed = await waitFor(() => {
    try {
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      if (record.status !== "completed") return false;
      const output = fs.readFileSync(record.outputFile, "utf8");
      return output.includes("after") ? { record, output } : false;
    } catch {
      return false;
    }
  });
  assert.equal(completed.record.launcher, "systemd");
  assert.ok(completed.record.processPid > 0);
  assert.match(completed.output, /before[\s\S]*after/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
