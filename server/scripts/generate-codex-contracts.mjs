import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'src/generated/codex');
const check = process.argv.includes('--check');
const command = process.env.SOCKETAGENT_CODEX_COMMAND || 'codex';
const cliVersion = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
const scratch = await mkdtemp(path.join(os.tmpdir(), 'socketagent-codex-contracts-'));
const schemaShape = z.object({ definitions: z.record(z.string(), z.unknown()) });

// These are the supported methods we call, not every experimental provider API.
const methods = [
  'initialize', 'thread/start', 'thread/resume', 'thread/fork', 'thread/read',
  'thread/list', 'thread/loaded/list', 'thread/turns/list', 'thread/archive', 'thread/delete',
  'thread/unarchive', 'thread/unsubscribe', 'thread/inject_items', 'thread/revert',
  'thread/compact/start', 'thread/name/set', 'thread/metadata/update',
  'thread/goal/get', 'thread/goal/set', 'thread/goal/clear',
  'turn/start', 'turn/steer', 'turn/interrupt', 'review/start',
  'model/list', 'config/read', 'collaborationMode/list', 'mcpServerStatus/list',
  'account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume',
  'account/usage/read', 'account/login/start', 'account/login/cancel',
];

/** @param {string} directory @returns {Promise<string[]>} */
async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(name));
    else files.push(name);
  }
  return files.sort();
}

try {
  execFileSync(command, ['app-server', 'generate-ts', '--experimental', '--out', path.join(scratch, 'types')], { timeout: 60_000 });
  execFileSync(command, ['app-server', 'generate-json-schema', '--experimental', '--out', path.join(scratch, 'json')], { timeout: 60_000 });
  const clientSource = await readFile(path.join(scratch, 'types/ClientRequest.ts'), 'utf8');
  const client = ts.createSourceFile('ClientRequest.ts', clientSource, ts.ScriptTarget.Latest, true);
  /** @type {Map<string, string>} */
  const imports = new Map();
  /** @type {Map<string, string>} */
  const paramsByMethod = new Map();
  for (const statement of client.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) imports.set(binding.name.text, statement.moduleSpecifier.text);
      }
    }
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== 'ClientRequest' || !ts.isUnionTypeNode(statement.type)) continue;
    for (const variant of statement.type.types) {
      if (!ts.isTypeLiteralNode(variant)) throw new Error('Unexpected Codex request union');
      let method;
      let params;
      for (const member of variant.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : '';
        if (name === 'method' && ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)) method = member.type.literal.text;
        if (name === 'params') {
          const candidates = ts.isUnionTypeNode(member.type) ? member.type.types : [member.type];
          const reference = candidates.find(ts.isTypeReferenceNode);
          if (reference && ts.isTypeReferenceNode(reference) && ts.isIdentifier(reference.typeName)) params = reference.typeName.text;
        }
      }
      if (method && params) paramsByMethod.set(method, params);
    }
  }
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @param {string} relative */
  async function copyType(relative) {
    const key = `types/${relative}`;
    if (files.has(key)) return;
    const source = await readFile(path.join(scratch, key), 'utf8');
    files.set(key, source);
    const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        await copyType(path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${statement.moduleSpecifier.text}.ts`)));
      }
    }
  }
  const importLines = [];
  const methodLines = [];
  const responseLines = [];
  const baseSchema = schemaShape.parse(JSON.parse(await readFile(path.join(scratch, 'json/codex_app_server_protocol.schemas.json'), 'utf8')));
  const schema = schemaShape.parse(JSON.parse(await readFile(path.join(scratch, 'json/codex_app_server_protocol.v2.schemas.json'), 'utf8')));
  // Initialization belongs to the outer RPC protocol; the remaining methods are v2.
  /** @type {unknown} */
  const initializeResponse = JSON.parse(JSON.stringify(baseSchema.definitions.InitializeResponse).replaceAll('#/definitions/v2/', '#/definitions/'));
  schema.definitions.InitializeResponse = initializeResponse;
  const schemaText = JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', definitions: schema.definitions }, null, 2) + '\n';
  for (const method of methods) {
    const params = paramsByMethod.get(method);
    const module = params && imports.get(params);
    if (!params || !module) throw new Error(`Codex removed a required API: ${method}`);
    const response = params.replace(/Params$/, 'Response');
    const responseModule = `${path.posix.dirname(module)}/${response}`;
    await copyType(`${module.replace(/^\.\//, '')}.ts`);
    await copyType(`${responseModule.replace(/^\.\//, '')}.ts`);
    if (!schema.definitions[params] || !schema.definitions[response]) throw new Error(`Missing JSON contract for ${method}`);
    importLines.push(`import type { ${params} } from "./types/${module.replace(/^\.\//, '')}";`,
      `import type { ${response} } from "./types/${responseModule.replace(/^\.\//, '')}";`);
    methodLines.push(`  "${method}": { params: ${params}; response: ${response} };`);
    responseLines.push(`  "${method}": "${response}",`);
  }
  await copyType('ServerNotification.ts');
  await copyType('ServerRequest.ts');
  files.set('methods.ts', `// Generated by scripts/generate-codex-contracts.mjs from ${cliVersion}.\n${importLines.join('\n')}\n\nexport interface CodexMethods {\n${methodLines.join('\n')}\n}\n\nexport const codexResponseSchemas = {\n${responseLines.join('\n')}\n} as const;\n`);
  files.set('protocol.schemas.json', schemaText);
  files.set('manifest.json', JSON.stringify({ cliVersion, experimental: true,
    methods, sha256: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) =>
      [name, createHash('sha256').update(content).digest('hex')])) }, null, 2) + '\n');

  if (check) {
    const actual = await listFiles(output);
    const actualNames = new Set(actual.map(file => path.relative(output, file).split(path.sep).join('/')));
    const changes = [];
    for (const [name, content] of files) {
      if (!actualNames.has(name) || await readFile(path.join(output, name), 'utf8') !== content) changes.push(name);
      actualNames.delete(name);
    }
    changes.push(...actualNames);
    if (changes.length) throw new Error(`Codex protocol differs (${cliVersion}): ${changes.slice(0, 20).join(', ')}. Regenerate and review before accepting the update.`);
    console.log(`Codex contracts match ${cliVersion}: ${methods.length} methods.`);
  } else {
    await mkdir(output, { recursive: true });
    for (const [name, content] of files) {
      const destination = path.join(output, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    for (const file of await listFiles(output)) {
      if (!files.has(path.relative(output, file).split(path.sep).join('/'))) await rm(file);
    }
    console.log(`Generated ${files.size} files for ${methods.length} Codex methods (${cliVersion}).`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
