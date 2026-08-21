const test = require("node:test");
const assert = require("node:assert/strict");

const {
  codexAuthScopeFromAccountRead,
  isCodexActiveWriterError,
  isMcpAuthSignal,
} = require("../dist/codex-session.js");

test("routes a missing required OpenAI account to primary reauthentication", () => {
  assert.equal(
    codexAuthScopeFromAccountRead(
      { account: null, requiresOpenaiAuth: true },
      true,
    ),
    "openai",
  );
});

test("keeps an MCP token failure scoped to MCP when the OpenAI account exists", () => {
  assert.equal(
    codexAuthScopeFromAccountRead(
      {
        account: { type: "chatgpt", email: "user@example.com" },
        requiresOpenaiAuth: true,
      },
      true,
    ),
    "mcp",
  );
});

test("recognizes codex_apps and startup reauthentication as MCP auth signals", () => {
  assert.equal(
    isMcpAuthSignal(
      "codex_apps: MCP client failed with HTTP 401 token_expired",
    ),
    true,
  );
  assert.equal(
    isMcpAuthSignal({
      method: "mcpServer/startupStatus/updated",
      failureReason: "reauthenticationRequired",
      error: "authentication expired",
    }),
    true,
  );
});

test("recognizes the app-server active writer rejection", () => {
  assert.equal(
    isCodexActiveWriterError(
      new Error(
        'thread/resume: {"code":-32600,"message":"thread abc already has an active writer"}',
      ),
    ),
    true,
  );
  assert.equal(isCodexActiveWriterError(new Error("usage limit exceeded")), false);
});
