const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { serveDownloadFile } = require('../dist/http-file-download');
const { modelDownloadArchive } = require('../dist/model-download-archive');

test('HTTP ranges validate revisions, reject invalid offsets and handle empty files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'download-http-'));
  const file = path.join(directory, 'data');
  fs.writeFileSync(file, 'abcdefgh');
  const server = http.createServer((req, res) => serveDownloadFile(req, res, file));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/file`;
  try {
    const first = await fetch(url);
    const etag = first.headers.get('etag');
    assert.equal(await first.text(), 'abcdefgh');
    const resumed = await fetch(url, { headers: { Range: 'bytes=3-', 'If-Range': etag } });
    assert.equal(resumed.status, 206);
    assert.equal(resumed.headers.get('content-range'), 'bytes 3-7/8');
    assert.equal(await resumed.text(), 'defgh');
    const complete = await fetch(url, { headers: { Range: 'bytes=8-', 'If-Range': etag } });
    assert.equal(complete.status, 416);
    assert.equal(complete.headers.get('etag'), etag);
    assert.equal(complete.headers.get('content-range'), 'bytes */8');
    fs.writeFileSync(file, 'NEW');
    const changed = await fetch(url, { headers: { Range: 'bytes=3-', 'If-Range': etag } });
    assert.equal(changed.status, 200);
    assert.equal(await changed.text(), 'NEW');
    for (const range of ['bytes=-', 'bytes=-0', 'bytes=6-2', 'bytes=0-1,4-5']) {
      const response = await fetch(url, { headers: { Range: range } });
      assert.equal(response.status, 416, range);
      await response.text();
    }
    fs.writeFileSync(file, '');
    const empty = await fetch(url);
    assert.equal(empty.status, 200);
    assert.equal(await empty.text(), '');
    fs.unlinkSync(file);
    const missing = await fetch(url);
    assert.equal(missing.status, 404);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('model directory archives remain stable across retries and change with source revision', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'download-archive-'));
  const source = path.join(directory, 'source');
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'voice'), 'one');
  const cache = path.join(directory, 'cache');
  try {
    const [first, concurrent] = await Promise.all([modelDownloadArchive(source, cache), modelDownloadArchive(source, cache)]);
    assert.equal(first, concurrent);
    assert.equal(first, await modelDownloadArchive(source, cache));
    fs.writeFileSync(path.join(source, 'voice'), 'two changed');
    const second = await modelDownloadArchive(source, cache);
    assert.notEqual(second, first);
    assert.ok(fs.existsSync(first), 'old download remains resumable');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
