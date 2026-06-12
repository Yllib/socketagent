#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  codexRolloutJsonlToHistory,
  codexAppServerThreadToHistory,
} = require("../dist/codex-native-history");

function line(type, payload, timestamp = "2026-01-01T00:00:00.000Z") {
  return JSON.stringify({ type, timestamp, payload });
}

function withTempHome(fn) {
  const prev = process.env.HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-history-"));
  process.env.HOME = dir;
  try {
    return fn(dir);
  } finally {
    process.env.HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rollout = [
  line("event_msg", { type: "user_message", message: "hello" }),
  line("response_item", { type: "message", role: "assistant", content: [{ type: "text", text: "hi" }] }),
  line("response_item", {
    type: "function_call",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "true" }),
    call_id: "call_1",
  }),
  line("response_item", {
    type: "function_call_output",
    call_id: "call_1",
    output: "Chunk ID: x\nWall time: 0\nProcess exited with code 0\nOutput:\n",
  }),
  line("response_item", {
    type: "custom_tool_call",
    name: "apply_patch",
    input: "*** Begin Patch\n*** End Patch\n",
    call_id: "patch_1",
  }),
  line("response_item", {
    type: "custom_tool_call_output",
    call_id: "patch_1",
    output: "Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM a.txt\n",
  }),
  line("response_item", {
    type: "tool_search_call",
    call_id: "search_1",
    arguments: { query: "SendFile", limit: 5 },
  }),
  line("response_item", {
    type: "tool_search_output",
    call_id: "search_1",
    tools: [{ name: "SendFile" }],
  }),
].join("\n");

const converted = codexRolloutJsonlToHistory(rollout);
assert.deepStrictEqual(converted.map((e) => e.role), [
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "tool_call",
  "tool_result",
  "tool_call",
  "tool_result",
]);
assert.strictEqual(converted[2].toolName, "Bash");
assert.strictEqual(converted[3].content, "(no output)");
assert.strictEqual(converted[4].toolName, "ApplyPatch");
assert.strictEqual(converted[6].toolName, "ToolSearch");

const appServer = codexAppServerThreadToHistory({
  id: "thread_1",
  turns: [{
    startedAt: 1760000000,
    items: [
      { type: "userMessage", content: [{ type: "text", text: "run ls" }] },
      { type: "commandExecution", id: "cmd_1", command: "ls", aggregatedOutput: "", exitCode: 0 },
    ],
  }],
});
assert.strictEqual(appServer[0].role, "user");
assert.strictEqual(appServer[1].toolName, "Bash");
assert.strictEqual(appServer[2].content, "(no output)");

withTempHome((home) => {
  const sessionStorePath = require.resolve("../dist/session-store");
  delete require.cache[sessionStorePath];
  const { appendNativeHistorySuffix } = require("../dist/session-store");
  const historyDir = path.join(home, ".claude-assistant", "history");
  fs.mkdirSync(historyDir, { recursive: true });
  const sid = "suffix-test";
  const historyFile = path.join(historyDir, `${sid}.json`);
  fs.writeFileSync(historyFile, JSON.stringify([
    { role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "hi", timestamp: "2026-01-01T00:00:01.000Z" },
  ]));

  const toolOnly = appendNativeHistorySuffix(sid, [
    { role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "hi", timestamp: "2026-01-01T00:00:01.000Z" },
    { role: "tool_call", content: "old", toolName: "Bash", toolUseId: "old", timestamp: "2026-01-01T00:00:02.000Z" },
  ]);
  assert.strictEqual(toolOnly.length, 0);

  const textSuffix = appendNativeHistorySuffix(sid, [
    { role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "hi", timestamp: "2026-01-01T00:00:01.000Z" },
    { role: "user", content: "next", timestamp: "2026-01-01T00:00:02.000Z" },
    { role: "assistant", content: "done", timestamp: "2026-01-01T00:00:03.000Z" },
  ]);
  assert.strictEqual(textSuffix.length, 2);
});

console.log("codex native history adapter tests passed");
