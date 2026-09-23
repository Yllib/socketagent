const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
require('./test-data-dir');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'socketagent-inline-images-'));
process.env.SOCKET_AGENT_DATA_DIR = path.join(root, 'data');
const { InlineImageStore, inlineImageStore, MAX_INLINE_IMAGE_BYTES } = require('../dist/inline-image-store');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('snapshots preserve bytes across source edits, deletion and store restart', async () => {
  const source = path.join(root, 'source.png');
  const directory = path.join(root, 'store');
  const store = new InlineImageStore(directory);
  fs.writeFileSync(source, png);
  const first = await store.prepare(source, 'session');
  const revised = Buffer.concat([png, Buffer.from('revision')]);
  fs.writeFileSync(source, revised);
  const second = await store.prepare(source, 'session');
  fs.unlinkSync(source);
  const restarted = new InlineImageStore(directory);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(fs.readFileSync(restarted.resolve(first.uri)), png);
  assert.deepEqual(fs.readFileSync(restarted.resolve(second.uri)), revised);
  assert.equal((await restarted.prepare(first.uri, 'branch-session')).created, false);
  restarted.remove(first.id);
  await assert.rejects(restarted.prepare(first.uri, 'branch-session'), /cleaned up/);
  assert.deepEqual(fs.readFileSync(restarted.resolve(second.uri)), revised);
});

test('URL images remain readable after the original web server disappears', async () => {
  const web = http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'image/png'}); res.end(png); });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  try {
    const store = new InlineImageStore(path.join(root, 'url-store'));
    const saved = await store.prepare(`http://127.0.0.1:${web.address().port}/image?secret=omit-me`, 'session');
    await new Promise(resolve => web.close(resolve));
    assert.deepEqual(fs.readFileSync(store.resolve(saved.uri)), png);
    const metadata = fs.readFileSync(path.join(path.dirname(store.resolve(saved.uri)), 'metadata.json'), 'utf8');
    assert.ok(!metadata.includes('omit-me'));
  } finally { web.close(); }
});

test('rejects invalid images, oversized sources, and snapshot path traversal', async () => {
  const store = new InlineImageStore(path.join(root, 'invalid-store'));
  const source = path.join(root, 'invalid.png');
  fs.writeFileSync(source, '<html>not an image</html>');
  await assert.rejects(store.prepare(source, 'session'), /PNG/);
  fs.truncateSync(source, MAX_INLINE_IMAGE_BYTES + 1);
  await assert.rejects(store.prepare(source, 'session'), /20 MB/);
  for (const uri of ['socketagent://image?id=../../secret', 'socketagent://image?path=/etc/passwd', 'https://image?id=123']) {
    assert.throws(() => store.resolve(uri), /snapshot ID/);
  }
});

