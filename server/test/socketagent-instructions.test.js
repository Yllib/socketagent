const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSocketAgentIntegrationInstructions,
} = require("../dist/socketagent-instructions");

test("builds compact SocketAgent routing instructions without losing safety rules", () => {
  const prompt = buildSocketAgentIntegrationInstructions({
    mcpServerName: "socketagent_app",
    toolNames: ["HtmlPlan", "SendFile", "RequestSecureInput", "TaskBatch"],
    secureInventory: "<secret_inventory>\n[]\n</secret_inventory>",
    discoverMissingTools: true,
  });

  assert.match(prompt, /MCP server: socketagent_app/);
  assert.match(prompt, /HtmlPlan is reserved for detailed implementation or design plans for larger tasks/);
  assert.match(prompt, /multi-component architecture/);
  assert.match(prompt, /UI\/page mockups/);
  assert.match(prompt, /Do not use HtmlPlan for checklists, TODO lists, routine status updates/);
  assert.match(prompt, /Use your native plan\/task tool or TaskBatch for working plans and progress tracking/);
  assert.doesNotMatch(prompt, /the agent's native plan\/task tool/);
  assert.match(prompt, /normal chat for concise user-facing content, whichever is appropriate/);
  assert.match(prompt, /inline SVG\/CSS or data-image assets/);
  assert.match(prompt, /Never request secrets in normal chat/);
  assert.match(prompt, /absolute file_path/);
  assert.match(prompt, /discover tools for socketagent_app/);
  assert.match(prompt, /Independent delegated work.*AgentSession/);
  assert.match(prompt, /Two or more working-task mutations -> TaskBatch/);
  assert.match(prompt, /instead of looping single-task tools/);
  assert.match(prompt, /TaskBatch preserves native Claude tasks/);
  assert.match(prompt, /reports its completed turn back automatically/);
  assert.match(prompt, /Messages sent to a running child are injected at its next safe boundary/);
  assert.match(prompt, /socketagent:\/\/file\/download/);
  assert.match(prompt, /<secret_inventory>\n\[\]\n<\/secret_inventory>/);
});

test("can route Claude to the durable qualified Monitor without name ambiguity", () => {
  const prompt = buildSocketAgentIntegrationInstructions({
    mcpServerName: "app",
    toolNames: ["Monitor"],
    secureInventory: "<secret_inventory>\n[]\n</secret_inventory>",
    monitorToolReference: "mcp__app__Monitor",
  });

  assert.match(prompt, /Background command monitoring -> mcp__app__Monitor/);
  assert.match(prompt, /not Claude's built-in Monitor/);
  assert.match(prompt, /not durable across SocketAgent turns or server restarts/);
});
