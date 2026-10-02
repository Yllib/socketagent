import './test-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { importSessionTransfer } from '#server/session-transfer';
import { getSession } from '#server/session-store';

test('a checksummed bundle with malformed or missing records is rejected before importing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'socketagent-invalid-transfer-'));
  const bundlePath = path.join(dir, 'bundle.satransfer');
  const source = { serverLabel: 'source', sessionId: 'source-session', backend: 'claude', cwd: dir };
  const session = { id: source.sessionId, title: 'Source', cwd: dir,
    createdAt: '2026-09-27T10:00:00Z', lastActive: '2026-09-27T10:00:00Z', messagePreview: '' };
  const header = { kind: 'header', schema: 'socketagent.session-transfer', version: 2,
    bundleId: 'bundle-id', createdAt: session.createdAt, source, session,
    todos: [], htmlPlans: [], handoffContext: '', transcript: 'full', native: false };
  const end = { kind: 'end', history: 0, sdkEvents: 0, native: 0 };
  try {
    /** @type {Array<[object[], RegExp]>} */
    const cases = [
      [[header, { kind: 'history', entry: { role: 'user', content: { malformed: true }, timestamp: '' } }, end], /invalid SocketAgent session transfer bundle/],
      [[{ ...header, todos: [null] }, end], /invalid SocketAgent session transfer bundle/],
      [[{ ...header, session: { ...session, agentSettings: { thinking: { type: 'enabled', budgetTokens: 'many' } } } }, end], /invalid SocketAgent session transfer bundle/],
      // An export cut short before its end record.
      [[header, { kind: 'history', entry: { role: 'user', content: 'hi', timestamp: '', entryId: 'entry-1', sessionSeq: 1 } }], /invalid SocketAgent session transfer bundle \(end\)/],
      // Stored entries always have a durable position.
      [[header, { kind: 'history', entry: { role: 'user', content: 'hi', timestamp: '' } }, { ...end, history: 1 }], /invalid SocketAgent session transfer bundle \(history.sessionSeq\)/],
      [[{ ...header, version: 1 }, end], /Update SocketAgent on both computers/],
    ];
    for (const [records, error] of cases) {
      const bytes = gzipSync(records.map((record) => JSON.stringify(record)).join('\n'));
      writeFileSync(bundlePath, bytes);
      await assert.rejects(importSessionTransfer({ bundlePath,
        expectedSha256: createHash('sha256').update(bytes).digest('hex'),
        targetCwd: dir, targetBackend: 'claude', mode: 'clone', nativeMode: 'handoff',
        transferId: 'invalid-import',
      }), error);
      assert.equal(getSession('invalid-import'), undefined);
      assert.equal(existsSync(bundlePath), true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
