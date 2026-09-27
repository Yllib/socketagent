import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { compareBaseline, violationKey } from '../scripts/type-safety-baseline.mjs';

test('baseline allows line movement but rejects replacements, relocation, and extra copies', () => {
  const original = violationKey('src/a.ts', 'rule', ' const value = unsafe(); ', 'unsafe()');
  assert.equal(original, violationKey('src/a.ts', 'rule', 'const value = unsafe();', 'unsafe()'));
  const changed = violationKey('src/a.ts', 'rule', 'const another = unsafe();', 'unsafe()');
  const relocated = violationKey('src/b.ts', 'rule', 'const value = unsafe();', 'unsafe()');
  assert.equal(compareBaseline({ [original]: 1 }, { [changed]: 1 }).added.length, 1);
  assert.equal(compareBaseline({ [original]: 1 }, { [relocated]: 1 }).added.length, 1);
  assert.equal(compareBaseline({ [original]: 1 }, { [original]: 2 }).added.length, 1);
  assert.equal(compareBaseline({ [original]: 1 }, {}).removed.length, 1);
});

test('lint rejects explicit any, unsafe inferred values, cast bypasses, and suppression comments', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintText(`
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
