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

test('a checksummed bundle with malformed nested data is rejected before importing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'socketagent-invalid-transfer-'));
  const bundlePath = path.join(dir, 'bundle.satransfer');
  const source = { serverLabel: 'source', sessionId: 'source-session', backend: 'claude', cwd: dir };
  const session = { id: source.sessionId, title: 'Source', cwd: dir,
    createdAt: '2026-09-27T10:00:00Z', lastActive: '2026-09-27T10:00:00Z', messagePreview: '' };
  try {
    for (const patch of [
      { history: [{ role: 'user', content: { malformed: true }, timestamp: '' }] },
      { todos: [null] },
      { session: { ...session, agentSettings: { thinking: { type: 'enabled', budgetTokens: 'many' } } } },
    ]) {
      const bundle = { schema: 'socketagent.session-transfer', version: 1,
        bundleId: 'bundle-id', createdAt: session.createdAt, source, session,
        history: [], todos: [], htmlPlans: [], sdkEvents: [], handoffContext: '', ...patch };
      const bytes = gzipSync(JSON.stringify(bundle));
      writeFileSync(bundlePath, bytes);
      await assert.rejects(importSessionTransfer({ bundlePath,
        expectedSha256: createHash('sha256').update(bytes).digest('hex'),
        targetCwd: dir, targetBackend: 'claude', mode: 'clone', nativeMode: 'handoff',
        transferId: 'invalid-import',
      }), /Incomplete or invalid SocketAgent session transfer bundle/);
      assert.equal(getSession('invalid-import'), undefined);
      assert.equal(existsSync(bundlePath), true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
