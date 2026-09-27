import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { inferredTypeDiagnostics } from '../scripts/inferred-type-audit.mjs';

test('compiler audit rejects unused implicit values, empty collections, generic defaults, and unsafe returns', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'type-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture.js');
  fs.writeFileSync(file, `
    export function ignored(parameter) {}
    export const values = [];
    export const lookup = new Map();
    export const pending = new Promise(resolve => {});
    export const holder = { nested: new Map() };
    export const { external } = JSON.parse('{}');
    export function unsafeReturn() { return JSON.parse('{}'); }
    /** @type {Map<string, number>} */
    export const typedMap = new Map();
    /** @param {unknown} value @returns {Promise<void>} */
    export async function checked(value) { if (typeof value === 'string') value.trim(); }
  `);
  const program = ts.createProgram([file], {
    allowJs: true, checkJs: false, strict: true, noEmit: true,
    target: ts.ScriptTarget.ES2022, types: [],
  });
  const source = program.getSourceFile(file);
  assert.ok(source);
  const diagnostics = inferredTypeDiagnostics(program, [source]);
  const names = new Set(diagnostics.map(diagnostic => diagnostic.name));
  for (const name of ['parameter', 'values', 'lookup', 'pending', 'nested', 'external', 'unsafeReturn return']) {
    assert.ok(names.has(name), `Missing compiler enforcement: ${name}`);
  }
  assert.equal(names.has('typedMap'), false);
  assert.equal(names.has('checked return'), false);
});

test('lint rejects explicit any, unsafe inferred values, cast bypasses, and suppression comments', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintText(`
    /* eslint-disable */
    export function unsafe(value: any) { return value.answer; }
    const parsed = JSON.parse('{}');
    export const narrowed = ({} as unknown) as { valid: boolean };
    // @ts-ignore
    export const field = parsed.field;
  `, { filePath: fileURLToPath(new URL('../src/codex-rewind-contract.ts', import.meta.url)) });
  const rules = new Set(results.flatMap(result => result.messages.map(message => message.ruleId)));
  for (const rule of ['no-explicit-any', 'no-unsafe-assignment', 'no-unsafe-member-access',
    'no-unsafe-return', 'no-unsafe-type-assertion', 'ban-ts-comment']) {
    assert.ok(rules.has(`@typescript-eslint/${rule}`), `Missing enforcement: ${rule}`);
  }
});
