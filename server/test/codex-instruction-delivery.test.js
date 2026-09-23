const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
require('./test-data-dir');
const { saveSession, getSession } = require('../dist/session-store');
const { deliverCodexInstructions, invalidateCodexInstructions } = require('../dist/codex-instruction-delivery');
const { CodexSession } = require('../dist/codex-session');
const { CodexAppServerClient } = require('../dist/codex-app-server-client');
const { buildCodexSpawn } = require('../dist/codex-env');

function sessionRecord(id = crypto.randomUUID()) {
  saveSession({ id, title: 'Instruction test', cwd: os.tmpdir(),
    createdAt: new Date().toISOString(), lastActive: new Date().toISOString(), messagePreview: '' });
  return id;
}

function guidance() {
  const session = new CodexSession({ readyState: 1, send() {} }, os.tmpdir(), []);
  // Avoid starting MCP infrastructure when inspecting thread parameters.
  session.appServerConfig = () => ({});
  return session.buildAppServerThreadParams().developerInstructions;
}

test('new threads receive image guidance in developerInstructions, not collaboration settings', async () => {
  const session = new CodexSession({ readyState: 1, send() {} }, os.tmpdir(), []);
  session.appServerConfig = () => ({});
  const instructions = session.buildAppServerThreadParams().developerInstructions;
  assert.match(instructions, /Inline chat images/);
  assert.match(instructions, /socketagent-compare/);
  assert.equal(session.codexCollaborationMode().settings.developer_instructions, null);
  const id = sessionRecord();
  await deliverCodexInstructions({ injectDeveloperInstructions() { assert.fail('new thread already has guidance'); } },
    id, instructions, true);
  assert.equal(getSession(id).codexInstructionDelivery.threadId, id);
});

test('resumed threads receive changed instructions once, including across session reconstruction', async () => {
  const id = sessionRecord();
  const calls = [];
  const client = { async injectDeveloperInstructions(...args) { calls.push(args); } };
  await deliverCodexInstructions(client, id, 'first instructions', false);
  await deliverCodexInstructions({ ...client }, id, 'first instructions', false);
  assert.equal(calls.length, 1);
  await deliverCodexInstructions(client, id, 'updated instructions', false);
  assert.equal(calls.length, 2);
  assert.match(calls[1][1], /updated instructions/);
  invalidateCodexInstructions(id);
  await deliverCodexInstructions(client, id, 'updated instructions', false);
  assert.equal(calls.length, 3, 'rewound/compacted history needs fresh guidance');
  const replacementId = sessionRecord();
  saveSession({ ...getSession(replacementId), codexInstructionDelivery: getSession(id).codexInstructionDelivery });
  await deliverCodexInstructions(client, replacementId, 'updated instructions', false);
  assert.equal(calls.length, 4, 'a replacement native thread cannot inherit an acknowledgement');
});

test('failed instruction delivery is retried and does not acknowledge the new version', async () => {
  const id = sessionRecord();
  const client = { async injectDeveloperInstructions() { throw new Error('RPC failed'); } };
  await assert.rejects(deliverCodexInstructions(client, id, 'instructions', false), /RPC failed/);
  assert.equal(getSession(id).codexInstructionDelivery, undefined);
  let delivered = false;
  await deliverCodexInstructions({ async injectDeveloperInstructions() { delivered = true; } }, id, 'instructions', false);
  assert.equal(delivered, true);
});

// Opt in to exercise the installed Codex binary against a LOCAL model endpoint.
// No AI account/API requests are made. Capturing the actual Responses payload
// catches accepted-but-ignored app-server settings that a mock RPC cannot.
test('installed Codex delivers image guidance in new and resumed model requests', {
  skip: process.env.SOCKETAGENT_TEST_CODEX_INSTRUCTIONS !== '1', timeout: 45000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'socketagent-instructions-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Local capture complete', type: 'invalid_request_error' } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const args = ['app-server', '--listen', 'stdio://', '-c', 'model_provider="socketagent_test"', '-c',
    `model_providers.socketagent_test={name="Local test",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`];
  let client;
  let threadId;
  const instructions = guidance();
  const startClient = async () => {
    client = new CodexAppServerClient({ cwd, ...buildCodexSpawn(args), requestTimeoutMs: 10000 });
    client.on('error', () => {});
    await client.initialize({ clientInfo: { name: 'socketagent_instruction_test', version: '1' }, capabilities: { experimentalApi: true } });
  };
  const turn = async () => {
    const completed = once(client, 'turn/completed', { signal: AbortSignal.timeout(10000) });
    await client.startTurn({ threadId, model: 'gpt-6-astra', input: [{ type: 'text', text: 'Capture this local test request.', text_elements: [] }] });
    await completed;
  };
  const developerText = request => (request.input || []).filter(item => item.role === 'developer')
    .map(item => JSON.stringify(item)).join('\n');
  try {
    await startClient();
    const started = await client.startThread({ cwd, model: 'gpt-6-astra', sandbox: 'read-only',
      approvalPolicy: 'never', developerInstructions: instructions });
    threadId = started.thread.id;
    assert.equal(started.modelProvider, 'socketagent_test', 'refuse any nonlocal model provider');
    sessionRecord(threadId);
    await deliverCodexInstructions(client, threadId, instructions, true);
    await turn();
    assert.match(developerText(requests[0]), /Inline chat images/);
    assert.match(developerText(requests[0]), /socketagent-compare/);
    await client.stop();
    await startClient();
    const updated = instructions + '\nSOCKETAGENT_UPDATED_GUIDANCE_TEST';
    const resumed = await client.resumeThread({ threadId, cwd, developerInstructions: updated });
    assert.equal(resumed.modelProvider, 'socketagent_test');
    await deliverCodexInstructions(client, threadId, updated, false);
    await turn();
    assert.match(developerText(requests[1]), /SOCKETAGENT_UPDATED_GUIDANCE_TEST/);
    const count = developerText(requests[1]).split('SOCKETAGENT_UPDATED_GUIDANCE_TEST').length - 1;
    await deliverCodexInstructions(client, threadId, updated, false);
    await turn();
    assert.equal(developerText(requests[2]).split('SOCKETAGENT_UPDATED_GUIDANCE_TEST').length - 1, count);
  } finally {
    try {
      if (threadId && client) {
        await client.archiveThread(threadId);
        await client.request('thread/delete', { threadId });
      }
    } finally {
      await client?.stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});
