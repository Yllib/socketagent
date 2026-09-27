import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const root = new URL('../', import.meta.url);
const output = new URL('src/generated/stored-data.schema.json', root);
// Validate stored records with their writer contracts; retain future fields.
const schema = createGenerator({
  path: fileURLToPath(new URL('src/stored-data-contracts.ts', root)),
  tsconfig: fileURLToPath(new URL('tsconfig.json', root)),
  type: 'StoredDataContracts',
  additionalProperties: true,
  jsDoc: 'none',
}).createSchema('StoredDataContracts');
const content = JSON.stringify(schema, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== content) {
    throw new Error('Stored data schema is stale. Run npm run storage:generate and review the changes.');
  }
  console.log('Stored data schema matches writer contracts.');
} else {
  await writeFile(output, content);
  console.log('Generated stored data schema.');
}
