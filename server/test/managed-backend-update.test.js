const assert = require("node:assert/strict");
const test = require("node:test");

const {
  managedBackendSpecsNeedingUpdate,
  parseNpmVersionOutput,
} = require("../dist/managed-backend-update");

test("does not reinstall managed backends whose versions are already current", () => {
  assert.deepEqual(managedBackendSpecsNeedingUpdate(
    {
      "@openai/codex": "0.144.6",
      "@anthropic-ai/claude-code": "2.1.215",
    },
    {
      "@openai/codex": "0.144.6",
      "@anthropic-ai/claude-code": "2.1.215",
    },
  ), []);
});

test("installs only missing or outdated managed backends", () => {
  assert.deepEqual(managedBackendSpecsNeedingUpdate(
    {
      "@openai/codex": "0.144.5",
    },
    {
      "@openai/codex": "0.144.6",
      "@anthropic-ai/claude-code": "2.1.215",
    },
  ), ["@openai/codex@latest", "@anthropic-ai/claude-code@latest"]);
});

test("parses npm scalar and version-list responses", () => {
  assert.equal(parseNpmVersionOutput('"0.144.6"'), "0.144.6");
  assert.equal(parseNpmVersionOutput('["0.144.5", "0.144.6"]'), "0.144.6");
  assert.equal(parseNpmVersionOutput("2.1.215"), "2.1.215");
});
