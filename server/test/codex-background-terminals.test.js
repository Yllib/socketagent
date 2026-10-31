const { parseServerMessage } = require("#server/server-message");
const assert = require("node:assert/strict"), test = require("node:test"), crypto = require("node:crypto");
require("./test-data-dir");
const { CodexSession } = require("#server/codex-session");

/** @type {CodexSession[]} */
const sessions = [];
test.afterEach(() => { for (const s of sessions.splice(0)) {
  clearTimeout(s.appServerIdleStopTimer);
  clearTimeout(s.pendingAppServerTurnCompletion);
  clearTimeout(s.backgroundTerminalPoll);
} });

function fixture() {
  /** @type {import("#server/protocol").ServerMessage[]} */
  const sent = [];
  const s = new CodexSession({ readyState: 1, send: (/** @type {string} */ v) => sent.push(parseServerMessage(JSON.parse(v))) }, "/tmp");
  sessions.push(s);
  s.sessionId = s.threadId = `terminals-${crypto.randomUUID()}`;
  /** @type {{ itemId: string; processId: string; command: string; cwd: string; osPid: null; cpuPercent: null; rssKb: null }[]} */
  let terminals = [];
  /** @type {{ method: string; params: unknown }[]} */
  const requests = [];
  s.appServer = {
    request: async (/** @type {string} */ method, /** @type {Record<string, unknown>} */ params) => {
      requests.push({ method, params });
      if (method === "thread/backgroundTerminals/list") return { data: terminals, nextCursor: null };
      if (method === "thread/backgroundTerminals/terminate") {
        const before = terminals.length;
        terminals = terminals.filter((terminal) => terminal.processId !== params.processId);
        return { terminated: terminals.length < before };
      }
      throw new Error(`unexpected ${method}`);
    },
    stop: async () => {},
    removeAllListeners: () => {},
  };
  s.appServerInitialized = true;
  const terminal = (/** @type {string} */ processId, /** @type {string} */ itemId, command = "sleep 600") =>
    ({ itemId, processId, command, cwd: "/tmp", osPid: null, cpuPercent: null, rssKb: null });
  return { s, sent, requests, terminal, setTerminals: (/** @type {typeof terminals} */ next) => { terminals = next; } };
}

test("background terminals reach the app as stoppable background tasks tied to their command card", async () => {
  const f = fixture();
  f.s.handleAppServerNotification("item/started", { threadId: f.s.threadId,
    item: { type: "commandExecution", id: "exec-1", command: "sleep 600", cwd: "/tmp", status: "inProgress", commandActions: [] } });
  f.setTerminals([f.terminal("5984", "exec-1")]);
  await f.s.refreshBackgroundTerminals();
  const changed = f.sent.filter((m) => m.type === "background_tasks_changed");
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].tasks, [{ taskId: "5984", taskType: "codex_terminal", description: "sleep 600", toolUseId: "exec-1" }]);
  assert.deepEqual([...f.s.activeBackgroundTasks], [["5984", "exec-1"]]);
  assert.equal(f.s.isBusy, true);

  // The turn settles without closing the still-running command's card.
  f.s.settleActiveAppServerToolCalls("");
  assert.equal(f.sent.some((m) => m.type === "tool_result" && m.toolUseId === "exec-1"), false);

  // An unchanged list sends nothing more.
  await f.s.refreshBackgroundTerminals();
  assert.equal(f.sent.filter((m) => m.type === "background_tasks_changed").length, 1);

  await f.s.stopTask("exec-1");
  assert.ok(f.requests.some((r) => r.method === "thread/backgroundTerminals/terminate" && r.params.processId === "5984"));
  const last = f.sent.filter((m) => m.type === "background_tasks_changed").at(-1);
  assert.deepEqual(last.tasks, []);
  assert.equal(f.s.isBusy, false);
  assert.equal(f.s.activeBackgroundTasks.size, 0);
});

test("stopping an unknown task sends nothing to Codex", async () => {
  const f = fixture();
  await f.s.stopTask("nope");
  assert.equal(f.requests.length, 0);
});

test("a CLI without the terminal list tracks nothing", async () => {
  const f = fixture();
  const { CodexAppServerProtocolError } = require("#server/codex-app-server-client");
  f.s.appServer.request = async (/** @type {string} */ method) => {
    throw new CodexAppServerProtocolError(method, { code: -32601, message: "Method not found" }, "Method not found");
  };
  await f.s.refreshBackgroundTerminals();
  assert.equal(f.s.activeBackgroundTasks.size, 0);
  assert.equal(f.sent.filter((m) => m.type === "background_tasks_changed").length, 0);
});
