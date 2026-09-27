import { ESLint } from 'eslint';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineSchema, compareBaseline, violationKey } from './type-safety-baseline.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const baselinePath = path.join(root, 'type-safety-baseline.json');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--prune', '--init', '--report'].includes(mode)) {
  throw new Error('Usage: check-type-safety.mjs [--check|--prune|--report]');
}
const eslint = new ESLint({ cwd: root });
const results = await eslint.lintFiles(['src/**/*.{ts,mts}', 'test/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'eslint.config.mjs']);
/** @type {Record<string, number>} */
const entries = {};
/** @type {Map<string, string>} */
const locations = new Map();
/** @type {Record<string, number>} */
const byRule = {};
/** @type {Record<string, number>} */
const byFile = {};
let fatal = false;
for (const result of results) {
  const file = path.relative(root, result.filePath).split(path.sep).join('/');
  const source = result.source ?? await readFile(result.filePath, 'utf8');
  const lines = source.split(/\r?\n/);
  for (const message of result.messages) {
    // Parser/configuration errors and ignored disable directives are never baseline debt.
    if (message.fatal || !message.ruleId) {
      console.error(`${file}:${message.line}: ${message.message}`);
      fatal = true;
      continue;
    }
    const start = message.line - 1;
    const end = (message.endLine ?? message.line) - 1;
    const selected = lines.slice(start, end + 1);
    if (selected.length) {
      selected[selected.length - 1] = selected[selected.length - 1].slice(0, (message.endColumn ?? message.column) - 1);
      selected[0] = selected[0].slice(message.column - 1);
    }
    const key = violationKey(file, message.ruleId, lines[start] ?? '', selected.join('\n'));
    entries[key] = (entries[key] ?? 0) + 1;
    byRule[message.ruleId] = (byRule[message.ruleId] ?? 0) + 1;
    byFile[file] = (byFile[file] ?? 0) + 1;
    locations.set(key, `${file}:${message.line}:${message.column} ${message.ruleId}: ${message.message}`);
  }
}
if (fatal) process.exit(1);
const current = { version: 1, entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) };
if (mode === '--init') {
  // Exclusive creation makes this a one-time bootstrap, never a reset command.
  await writeFile(baselinePath, JSON.stringify(current, null, 2) + '\n', { flag: 'wx' });
} else {
  const baseline = baselineSchema.parse(JSON.parse(await readFile(baselinePath, 'utf8')));
  const { added, removed } = compareBaseline(baseline.entries, entries);
  if (mode === '--report') console.log(JSON.stringify({ byRule,
    byFile: Object.fromEntries(Object.entries(byFile).sort(([, a], [, b]) => b - a)),
    added: added.length, removed: removed.length }, null, 2));
  if (added.length) {
    for (const [key] of added.slice(0,60)) console.error(locations.get(key));
    console.error(`${added.length} new type-safety violation locations. Fix them; the baseline cannot grow.`);
    process.exit(1);
  }
  if (mode === '--prune') {
    await writeFile(baselinePath, JSON.stringify(current, null, 2) + '\n');
  } else if (removed.length) {
    console.error(`${removed.length} resolved baseline locations. Run npm run type-safety:prune to remove their allowances.`);
    process.exit(1);
  }
}
console.log(`Type safety: ${Object.values(entries).reduce((sum, count) => sum + count, 0)} existing diagnostics; no new violations.`);
