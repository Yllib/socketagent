import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { parseCodexResponse } from '../dist/codex-contracts.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('generated response validation rejects protocol drift without logging response contents', () => {
  assert.deepEqual(parseCodexResponse('thread/goal/get', { goal: null }), { goal: null });
  const goal = { threadId: 't', objective: 'private objective', status: 'active', tokenBudget: null,
    tokensUsed: 5, timeUsedSeconds: 2, createdAt: 100, updatedAt: 101 };
  assert.deepEqual(parseCodexResponse('thread/goal/get', { goal }), { goal });
  assert.throws(() => parseCodexResponse('thread/goal/get', { goal: { ...goal, status: 'made-up' } }), error =>
    error instanceof Error && error.message.includes('invalid thread/goal/get') && !error.message.includes('private objective'));
  assert.throws(() => parseCodexResponse('thread/goal/get', { goal: { ...goal, tokensUsed: '5' } }), /invalid/);
});

test('Codex request types reject unknown methods and invalid parameters without suppressions', () => {
  const file = path.join(root, 'src/__codex_contract_check__.ts');
  const source = `
    import { CodexAppServerClient } from './codex-app-server-client';
    const client = new CodexAppServerClient({ cwd: '/tmp' });
    client.request('thread/read', { threadId: 't', includeTurns: true });
    client.request('turn/interrupt', { threadId: 't', turnId: 'run' });
    client.request('thread/rollback', { threadId: 't', numTurns: 1 });
    client.request('made/up', {});
    client.request('thread/read', { threadId: 123, includeTurns: true });
    client.request('turn/interrupt', { threadId: 't' });
    client.request('thread/goal/set', { threadId: 't', status: 'invented' });
  `;
  const options = { strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true,
    resolveJsonModule: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS };
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  host.readFile = filename => filename === file ? source : read(filename);
  const exists = host.fileExists;
  host.fileExists = filename => filename === file || exists(filename);
  const program = ts.createProgram([file], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.file?.fileName === file);
  const lines = diagnostics.map(diagnostic => diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line);
  assert.deepEqual(lines, [6, 7, 8, 9], diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
});

test('generated Codex files match the recorded snapshot and every JSON reference resolves', async () => {
  const directory = path.join(root, 'src/generated/codex');
  const manifest = z.object({ cliVersion: z.string(), methods: z.array(z.string()), sha256: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')));
  assert.ok(manifest.methods.includes('thread/revert'));
  assert.ok(!manifest.methods.includes('thread/rollback'), 'Legacy rollback must stay separate from the current contract');
  for (const [name, hash] of Object.entries(manifest.sha256)) {
    const data = await readFile(path.join(directory, name));
    assert.equal(createHash('sha256').update(data).digest('hex'), hash, `${name} changed without regeneration`);
  }
  const schema = z.object({ definitions: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(await readFile(path.join(directory, 'protocol.schemas.json'), 'utf8')));
  /** @param {unknown} value */
  function visit(value) {
    if (Array.isArray(value)) {
      const values = z.array(z.unknown()).parse(value);
      for (const item of values) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const object = z.record(z.string(), z.unknown()).parse(value);
    if (typeof object.$ref === 'string') {
      assert.ok(object.$ref.startsWith('#/definitions/'), object.$ref);
      assert.ok(Object.hasOwn(schema.definitions, object.$ref.slice('#/definitions/'.length)), `Unresolved schema reference ${object.$ref}`);
    }
    for (const child of Object.values(object)) visit(child);
  }
  visit(schema);
});
