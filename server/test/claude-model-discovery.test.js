const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readClaudeSupportedModels } = require("../dist/claude-model-discovery");

// Exercise the real SDK transport. The child only answers initialization;
// a user prompt or persisted session would be visible in its recorded input.
function fixture(t, fail = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-discovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, "cli.js");
  fs.writeFileSync(cli, `
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(process.argv));
    require('node:readline').createInterface({input: process.stdin}).on('line', line => {
      fs.appendFileSync(path.join(__dirname, 'requests.jsonl'), line + '\\n');
      const request = JSON.parse(line);
      if (request.type !== 'control_request') return;
      process.stdout.write(JSON.stringify({type:'control_response',response: {
        subtype: ${fail ? "'error'" : "'success'"}, request_id: request.request_id,
        ${fail ? "error: 'Initialization unavailable'" : "response: {models: [{value:'opus-test',displayName:'Opus test',description:'test'}]}"}
      }}) + '\\n');
    });
  `);
  return { dir, options: { cwd: dir, pathToClaudeCodeExecutable: cli,
    executable: process.execPath, settingSources: [] } };
}

test("model discovery reads initialization metadata without a prompt or persistence", async (t) => {
  const { dir, options } = fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const models = await readClaudeSupportedModels(options);
    assert.equal(models[0].value, "opus-test");
  }
  const args = JSON.parse(fs.readFileSync(path.join(dir, "args.json"), "utf8"));
  assert.ok(args.includes("--no-session-persistence"));
  const requests = fs.readFileSync(path.join(dir, "requests.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.type === "control_request" && r.request.subtype === "initialize"));
});

test("initialization failure rejects without submitting a fallback prompt", async (t) => {
  const { dir, options } = fixture(t, true);
  await assert.rejects(readClaudeSupportedModels(options), /Initialization unavailable/);
  const requests = fs.readFileSync(path.join(dir, "requests.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.subtype, "initialize");
});
