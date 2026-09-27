import assert from 'node:assert/strict';
import test from 'node:test';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseSocketAgentPlugin } from '#server/plugin-contract';

test('plugin contracts preserve hook binding and validate dynamic results', async () => {
  const implementation = {
    name: 'test-plugin', cleaned: false,
    toolContextFragment() { return this.name; },
    cleanup() { this.cleaned = true; },
    allowedTools() { return ['mcp__test__*']; },
    envVars() { return { TEST_VARIABLE: 'value' }; },
  };
  const plugin = parseSocketAgentPlugin({ default: implementation });
  assert.equal(plugin.toolContextFragment?.(), 'test-plugin');
  assert.deepEqual(plugin.allowedTools?.(), ['mcp__test__*']);
  assert.deepEqual(plugin.envVars?.(), { TEST_VARIABLE: 'value' });
  await plugin.cleanup?.();
  assert.equal(implementation.cleaned, true);
  assert.throws(() => parseSocketAgentPlugin({ name: 'bad', envVars: {} }));
  assert.throws(() => parseSocketAgentPlugin({ name: 'bad', envVars: () => ({ INVALID: 4 }) }).envVars?.());
  assert.throws(() => parseSocketAgentPlugin({ name: 'bad', allowedTools: () => ['ok', 4] }).allowedTools?.());
});

test('plugin contracts reject malformed approval results', async () => {
  /** @type {import('#server/plugin-api').SessionContext} */
  const ctx = {
    sessionId: 's1', cwd: '/project', send() {}, appendHistory() {},
    pendingQuestions: new Map(), questionCounter: { next: () => 'q1' },
  };
  const allowed = parseSocketAgentPlugin({ name: 'allowed',
    canUseToolInterceptor: () => ({ behavior: 'allow', updatedInput: { command: 'pwd' } }),
    answerMiddleware: () => ({ handled: true, publicAnswers: { answer: 'yes' } }),
  });
  assert.deepEqual(await allowed.canUseToolInterceptor?.('Bash', {}, ctx), { behavior: 'allow', updatedInput: { command: 'pwd' } });
  assert.deepEqual(await allowed.answerMiddleware?.('q1', {}, ctx), { handled: true, publicAnswers: { answer: 'yes' } });
  const invalid = parseSocketAgentPlugin({ name: 'invalid',
    canUseToolInterceptor: () => ({ behavior: 'deny' }),
    answerMiddleware: () => ({ handled: true, publicAnswers: { answer: ['wrong'] } }),
  });
  await assert.rejects(async () => invalid.canUseToolInterceptor?.('Bash', {}, ctx));
  await assert.rejects(async () => invalid.answerMiddleware?.('q1', {}, ctx));
});

test('plugin MCP contracts accept real SDK instances and reject lookalikes', () => {
  const bundled = createSdkMcpServer({ name: 'bundled', tools: [] });
  const standalone = new McpServer({ name: 'standalone', version: '1' });
  const plugin = parseSocketAgentPlugin({ name: 'mcp', mcpServers: () => ({
    bundled, standalone: { type: 'sdk', name: 'standalone', instance: standalone },
    remote: { type: 'http', url: 'https://example.test/mcp', tools: [{ name: 'read', permission_policy: 'always_ask' }] },
  }) });
  const configs = plugin.mcpServers?.();
  assert.equal(configs?.bundled.type, 'sdk');
  if (configs?.bundled.type === 'sdk') assert.equal(configs.bundled.instance, bundled.instance);
  if (configs?.standalone.type === 'sdk') assert.equal(configs.standalone.instance, standalone);
  assert.throws(() => parseSocketAgentPlugin({ name: 'bad', mcpServers: () => ({
    fake: { type: 'sdk', name: 'fake', instance: { connect() {}, close() {} } },
  }) }).mcpServers?.());
});
