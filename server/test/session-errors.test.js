const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
require("./test-data-dir");

const { describeMcpStartupFailure } = require("#server/codex-mcp-errors");
const { deleteSessionArtifacts, getHistory, recordSessionError } = require("#server/session-store");

// What Codex reported when a cached DNS answer sent the docs server to the router.
const RAW = "MCP startup failed: handshaking with MCP server failed: Send message error Transport "
  + "[codex_rmcp_client::event_notification_transport::EventNotificationTransport<rmcp::transport::worker::"
  + "WorkerTransport<rmcp::transport::streamable_http_client::StreamableHttpClientWorker<codex_rmcp_client::"
  + "http_client_adapter::StreamableHttpClientAdapter>>>] error: Client error: HTTP request failed: "
  + "http/request failed: error sending request for url (https://developers.openai.com/mcp) when send initialize request";

test("an MCP startup failure reads as one plain sentence", () => {
  assert.equal(
    describeMcpStartupFailure("openaiDeveloperDocs", RAW),
    "Codex couldn't start the openaiDeveloperDocs MCP server at https://developers.openai.com/mcp: "
      + "the request couldn't reach it. This session continues without its tools.",
  );
  assert.match(
    describeMcpStartupFailure("local", "spawn failed: No such file or directory (os error 2)"),
    /local MCP server: its command couldn't be found\./,
  );
  const unknown = describeMcpStartupFailure("odd", "rmcp::service::Error: handshake rejected; retrying");
  assert.doesNotMatch(unknown, /::/);
  assert.match(unknown, /handshake rejected/);
});

test("a conversation error is saved where it happened", () => {
  const sessionId = `test-session-error-${randomUUID()}`;
  try {
    const message = { type: "error", message: "Something broke" };
    recordSessionError(sessionId, message);
    const saved = getHistory(sessionId).filter((entry) => entry.role === "error");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].content, "Something broke");
    // The live message carries the saved entry's position, so a reload matches it.
    assert.equal(message.entryId, saved[0].entryId);
    assert.equal(message.sessionSeq, saved[0].sessionSeq);
  } finally {
    deleteSessionArtifacts(sessionId);
  }
});
