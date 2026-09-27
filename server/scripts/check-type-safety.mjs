import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { inferredTypeDiagnostics } from './inferred-type-audit.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv[2] ?? '--check';
if (!['--check', '--report'].includes(mode) || process.argv.length > 3) {
  throw new Error('Usage: check-type-safety.mjs [--check|--report]');
}

const config = ts.readConfigFile(path.join(root, 'tsconfig.type-safety.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
/** @type {unknown} */
const configValue = config.config;
const parsed = ts.parseJsonConfigFileContent(configValue, ts.sys, root);
if (parsed.errors.length) {
  throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
}
const program = ts.createProgram(parsed.fileNames, parsed.options);
const roots = new Set(program.getRootFileNames());
const files = program.getSourceFiles().filter(file => roots.has(file.fileName));
if (!files.length) throw new Error('Type-safety project contains no files');
const inferred = inferredTypeDiagnostics(program, files);

const eslint = new ESLint({ cwd: root });
const results = await eslint.lintFiles(parsed.fileNames);
/** @type {Record<string, number>} */
const byRule = {};
/** @type {Record<string, number>} */
const byFile = {};
let count = 0;
for (const result of results) {
  const file = path.relative(root, result.filePath).split(path.sep).join('/');
  for (const message of result.messages) {
    count++;
    const rule = message.ruleId ?? 'configuration';
    byRule[rule] = (byRule[rule] ?? 0) + 1;
    byFile[file] = (byFile[file] ?? 0) + 1;
    console.error(`${file}:${message.line}:${message.column} ${rule}: ${message.message}`);
  }
}
for (const diagnostic of inferred) {
  count++;
  const file = path.relative(root, diagnostic.file).split(path.sep).join('/');
  byRule['inferred-any'] = (byRule['inferred-any'] ?? 0) + 1;
  byFile[file] = (byFile[file] ?? 0) + 1;
  console.error(`${file}:${diagnostic.line}:${diagnostic.column} inferred-any: ${diagnostic.name} has type ${diagnostic.type}`);
}
if (mode === '--report') console.log(JSON.stringify({ files: files.length, diagnostics: count, byRule, byFile }, null, 2));
if (count) {
  console.error(`Type safety failed: ${count} diagnostics. Fix the types or validate the boundary data.`);
  process.exitCode = 1;
} else {
  console.log(`Type safety: ${files.length} files, zero diagnostics.`);
}
