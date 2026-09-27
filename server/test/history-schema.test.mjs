import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHistoryEntry, parseHistoryEntries } from '../dist/history-schema.js';

test('legacy rollback system notes remain readable as notifications', () => {
  assert.deepEqual(parseHistoryEntry({ role: 'system', content: 'Rolled back 1 Codex turn', timestamp: 'old' }),
    { role: 'notification', content: 'Rolled back 1 Codex turn', timestamp: 'old' });
});

test('history validation retains future fields and defaults missing legacy display fields', () => {
  const value = { role: 'tool_call', toolName: 'Bash', toolInput: { command: 'pwd' }, futureField: { value: 1 } };
  const parsed = parseHistoryEntry(value);
  assert.deepEqual(parsed, { ...value, content: '', timestamp: '' });
  assert.deepEqual(value, { role: 'tool_call', toolName: 'Bash', toolInput: { command: 'pwd' }, futureField: { value: 1 } });
});

test('history validation checks optional and nested fields instead of only the role', () => {
  const entry = { role: 'question', content: '', timestamp: '2026-09-27T10:00:00Z' };
  for (const invalid of [
    { ...entry, content: 5 },
    { ...entry, sessionSeq: '10' },
    { ...entry, timestamp: null },
    { ...entry, questions: [{ question: 'Proceed?', options: [{ label: 3 }] }] },
    { ...entry, taskUsage: { totalTokens: 10, toolUses: 'two', durationMs: 3 } },
    { ...entry, runOutcome: 'running' },
  ]) {
    assert.throws(() => parseHistoryEntry(invalid));
  }
});

test('history arrays reject malformed entries without silently dropping messages', () => {
  const valid = { role: 'assistant', content: 'Keep this message', timestamp: '' };
  assert.throws(() => parseHistoryEntries([valid, null]));
  assert.throws(() => parseHistoryEntries({ entries: [valid] }));
  assert.deepEqual(parseHistoryEntries([valid]), [valid]);
});
