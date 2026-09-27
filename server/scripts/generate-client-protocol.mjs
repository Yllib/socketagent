import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const root = new URL('../', import.meta.url);
const output = new URL('src/generated/client-protocol.schema.json', root);
// Both runtime validation and compile-time routing derive from protocol.ts.
// Extra fields remain valid so older servers tolerate newer app capabilities.
const schema = createGenerator({
  path: fileURLToPath(new URL('src/protocol.ts', root)),
  tsconfig: fileURLToPath(new URL('tsconfig.json', root)),
  type: 'JsonClientMessage',
  additionalProperties: true,
  jsDoc: 'none',
}).createSchema('JsonClientMessage');
const content = JSON.stringify(schema, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== content) {
    throw new Error('Client protocol schema is stale. Run npm run protocol:generate and review the changes.');
  }
  console.log('Client protocol schema matches protocol.ts.');
} else {
  await writeFile(output, content);
  console.log('Generated client protocol schema.');
}
