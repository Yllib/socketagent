import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStoredSessions } from '../dist/session-schema.js';

const legacySession = {
  id: 'legacy-session', title: 'Saved session', cwd: '/project',
  createdAt: '2026-09-20T10:00:00Z', lastActive: '2026-09-27T10:00:00Z', messagePreview: 'Latest reply',
};

test('session metadata preserves legacy sessions and future provider fields', () => {
  const input = {
    ...legacySession, codexDriver: 'exec',
    lastContextUsage: { futureProviderField: [1, 2] },
    agentSettings: { effort: 'future-effort', futureSetting: true },
    futureMetadata: { version: 2 },
  };
  assert.deepEqual(parseStoredSessions([input]), [{ ...input, codexDriver: 'app-server' }]);
  assert.deepEqual(parseStoredSessions([legacySession]), [legacySession]);
  assert.equal(input.codexDriver, 'exec');
});

test('session metadata rejects malformed identity and nested settings without dropping sessions', () => {
  for (const patch of [
    { id: 3 }, { cwd: null }, { turnCount: '5' }, { codexDriver: 'unknown-driver' },
    { agentSettings: { thinking: { type: 'enabled', budgetTokens: 'many' } } },
    { runStats: { completedCount: 2, totalDurationMs: 20, current: { runId: 'r', startedAt: 1 } } },
  ]) {
    assert.throws(() => parseStoredSessions([legacySession, { ...legacySession, ...patch }]));
  }
});
