import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const root = new URL('../', import.meta.url);
// Derive both wire directions from protocol.ts. Additional fields preserve
// compatibility when a newer peer sends metadata an older build does not use.
for (const [type, filename] of [
  ['JsonClientMessage', 'client-protocol.schema.json'],
  ['ServerMessage', 'server-protocol.schema.json'],
]) {
  const output = new URL(`src/generated/${filename}`, root);
  const schema = createGenerator({
    path: fileURLToPath(new URL('src/protocol.ts', root)),
    tsconfig: fileURLToPath(new URL('tsconfig.json', root)),
    type,
    additionalProperties: true,
    jsDoc: 'none',
  }).createSchema(type);
  const content = JSON.stringify(schema, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(output, 'utf8') !== content) {
      throw new Error(`${filename} is stale. Run npm run protocol:generate and review the changes.`);
    }
    console.log(`${filename} matches protocol.ts.`);
  } else {
    await writeFile(output, content);
    console.log(`Generated ${filename}.`);
  }
}
