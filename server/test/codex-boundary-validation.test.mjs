import assert from 'node:assert/strict';
import test from 'node:test';
import './test-data-dir.js';
import { CodexAppServerClient } from '#server/codex-app-server-client';
import { codexRewindTarget, rewindCodexConversation, isCodexRewinding } from '#server/codex-conversation-rewind';
import { parseRewindPage } from '#server/codex-rewind-contract';
import { appendHistory, getHistory } from '#server/session-store';

test('rewind rejects malformed native turns and text instead of guessing a target', () => {
  const target = { uuid: 'target', content: 'prompt' };
  for (const turns of [[null], [{ id: 123 }], [{ id: 'turn', items: {} }],
    [{ id: 'turn', items: [{ type: 'userMessage', clientId: 'target', content: [{ type: 'text', text: 12 }] }] }]]) {
    assert.throws(() => codexRewindTarget({ turns }, target), /invalid|valid conversation/);
  }
  assert.throws(() => parseRewindPage({ data: [{ id: 'turn' }], nextCursor: 123 }), /valid retained turns/);
  assert.deepEqual(parseRewindPage({ data: [{ id: 'turn', futureField: true }], nextCursor: null, futureField: true }),
    { data: [{ id: 'turn' }], nextCursor: null });
});

test('invalid rewind data cannot trigger native mutation or local history truncation', async () => {
  const sessionId = 'typed-rewind-invalid-boundary';
  appendHistory(sessionId, { role: 'user', uuid: 'target', content: 'keep', timestamp: new Date().toISOString() });
  let mutations = 0;
  const mutate = async () => { mutations++; return {}; };
  const client = {
    resumeThread: async () => ({}),
    readThread: async () => ({ thread: { turns: [{ id: 42 }] } }),
    rollbackThread: mutate, revertThread: mutate, listThreadTurns: async () => ({ data: [] }),
  };
  await assert.rejects(rewindCodexConversation(client, sessionId, '/tmp', 'target'), /valid conversation turns/);
  assert.equal(mutations, 0);
  assert.equal(getHistory(sessionId).length, 1);
  assert.equal(isCodexRewinding(sessionId), false);
});

test('compaction ignores unrelated events and waits for matching item and turn completion', async () => {
  const client = new CodexAppServerClient({ cwd: process.cwd() });
  client.compactThread = async () => {
    client.emit('notification', { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
    client.emit('notification', { method: 'item/completed', params: { threadId: 'other', item: null } });
    client.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { type: 'contextCompaction', futureField: true } } });
    client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', error: null } } });
    return {};
  };
  await client.compactThreadAndWait('thread', 1000);
  assert.equal(client.listenerCount('notification'), 0);
});

test('malformed compaction data fails promptly and releases its listeners', async () => {
  const client = new CodexAppServerClient({ cwd: process.cwd() });
  client.compactThread = async () => {
    client.emit('notification', { method: 'turn/started', params: { threadId: 'thread', turn: { id: 42 } } });
    return {};
  };
  await assert.rejects(client.compactThreadAndWait('thread', 1000), /invalid turn\/started event/);
  assert.equal(client.listenerCount('notification'), 0);
});
