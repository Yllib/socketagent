const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSocketAgentIntegrationInstructions,
} = require("../dist/socketagent-instructions");

test("builds compact SocketAgent routing instructions without losing safety rules", () => {
  const prompt = buildSocketAgentIntegrationInstructions({
    mcpServerName: "socketagent_app",
    toolNames: ["HtmlPlan", "SendFile", "RequestSecureInput"],
    secureInventory: "<secret_inventory>\n[]\n</secret_inventory>",
    discoverMissingTools: true,
  });

  assert.match(prompt, /MCP server: socketagent_app/);
  assert.match(prompt, /HtmlPlan is reserved for detailed implementation or design plans for larger tasks/);
  assert.match(prompt, /multi-component architecture/);
  assert.match(prompt, /UI\/page mockups/);
  assert.match(prompt, /Do not use HtmlPlan for checklists, TODO lists, routine status updates/);
  assert.match(prompt, /native plan\/task tool for working plans and progress tracking/);
  assert.match(prompt, /normal chat for concise user-facing content, whichever is appropriate/);
  assert.match(prompt, /inline SVG\/CSS or data-image assets/);
  assert.match(prompt, /Never request secrets in normal chat/);
  assert.match(prompt, /absolute file_path/);
  assert.match(prompt, /discover tools for socketagent_app/);
  assert.match(prompt, /socketagent:\/\/file\/download/);
  assert.match(prompt, /<secret_inventory>\n\[\]\n<\/secret_inventory>/);
});
