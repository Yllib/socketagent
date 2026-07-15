const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeSendFileHistoryEntries } = require("../dist/session-store");

test("collapses the handler-generated SendFile pair into the canonical pair", () => {
  const normalized = normalizeSendFileHistoryEntries([
    {
      role: "tool_call",
      toolName: "SendFile",
      toolUseId: "exec-1",
      toolInput: { file_path: "/tmp/app.apk" },
      timestamp: "2026-07-15T12:00:00.000Z",
    },
    {
      role: "tool_call",
      toolName: "SendFile",
      toolUseId: "mcp_SendFile_duplicate",
      toolInput: { file_path: "/tmp/app.apk" },
      fileId: "file-1",
      fileName: "app.apk",
      fileSize: 42,
      timestamp: "2026-07-15T12:00:00.010Z",
    },
    {
      role: "tool_result",
      toolUseId: "mcp_SendFile_duplicate",
      toolOutput: "ready",
    },
    { role: "tool_result", toolUseId: "exec-1", toolOutput: "ready" },
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].toolUseId, "exec-1");
  assert.equal(normalized[0].fileId, "file-1");
  assert.equal(normalized[1].toolUseId, "exec-1");
});

test("does not collapse distinct later sends of the same file", () => {
  const normalized = normalizeSendFileHistoryEntries([
    {
      role: "tool_call",
      toolName: "SendFile",
      toolUseId: "exec-1",
      toolInput: { file_path: "/tmp/app.apk" },
      timestamp: "2026-07-15T12:00:00.000Z",
    },
    { role: "assistant", content: "later" },
    {
      role: "tool_call",
      toolName: "SendFile",
      toolUseId: "exec-2",
      toolInput: { file_path: "/tmp/app.apk" },
      timestamp: "2026-07-15T12:01:00.000Z",
    },
  ]);

  assert.equal(normalized.filter((entry) => entry.role === "tool_call").length, 2);
});
