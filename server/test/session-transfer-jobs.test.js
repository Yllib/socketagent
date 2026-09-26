const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { SessionTransferJobs } = require('../dist/session-transfer-jobs');
const { generateKeyPair } = require('../dist/relay-crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for transfer');
    await delay(10);
  }
}

// A ciphertext-only relay. Neither this router nor a phone receives the server keys.
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-job-test-'));
  const relay = new WebSocketServer({ port: 0 });
  await new Promise(resolve => relay.once('listening', resolve));
  const peers = new Map();
  let interrupt = false;
  let observedPlaintext = false;
  relay.on('connection', (socket, req) => {
    const role = req.headers.authorization.replace('Bearer ', '');
    peers.set(role, socket);
    const other = role === 'source' ? 'destination' : 'source';
    if (peers.has(other)) for (const peer of peers.values()) peer.send(JSON.stringify({ type: 'peer_ready' }));
    socket.on('message', (bytes, binary) => {
      assert.equal(binary, true);
      observedPlaintext ||= bytes.includes(Buffer.from('transferLineage'));
      if (interrupt) return;
      const peer = peers.get(other);
      if (peer?.readyState === WebSocket.OPEN) peer.send(bytes, { binary: true });
    });
    socket.on('close', () => { if (peers.get(role) === socket) peers.delete(role); });
  });
  const keys = [generateKeyPair(), generateKeyPair()];
  const payload = crypto.randomBytes(7 * 1024 * 1024 + 17);
  const checksum = crypto.createHash('sha256').update(payload).digest('hex');
  const jobId = crypto.randomUUID();
  let exports = 0, imports = 0, archives = 0, persistedBytes = 0;
  let source, destination;
  let stopAtChunk = false;
  let stopAfterImport = false;
  let receiptLost = false;
  const result = { session: { id: jobId, title: 'Test', transferLineage: { transferId: jobId } }, sourceSessionId: 'session-one', exactNativeResume: false };
  const hooks = {
    export: async () => {
      exports++;
      const bundlePath = path.join(directory, 'export.gz'); fs.writeFileSync(bundlePath, payload);
      return { bundlePath, fileSize: payload.length, sha256: checksum };
    },
    import: async (_config, bundlePath, sha256) => {
      assert.deepEqual(fs.readFileSync(bundlePath), payload);
      assert.equal(sha256, checksum); imports++; return result;
    },
    archive: async () => { assert.ok(imports > 0, 'Never archive before import'); archives++; },
    revision: () => '1',
    changed: () => {
      const bytes = destination?.status(jobId)?.bytes || 0;
      if (stopAfterImport && destination?.status(jobId)?.result) {
        stopAfterImport = false; receiptLost = true; interrupt = true;
        source.close(); destination.close();
      }
      if (stopAtChunk && bytes >= 512 * 1024 && bytes < payload.length) {
        persistedBytes = bytes; stopAtChunk = false; interrupt = true;
        source.close(); destination.close();
      }
    },
  };
  const create = () => {
    source = new SessionTransferJobs(path.join(directory, 'source'), keys[0], hooks);
    destination = new SessionTransferJobs(path.join(directory, 'destination'), keys[1], hooks);
  };
  create();
  const common = { jobId, sessionId: 'session-one', targetCwd: directory, targetBackend: 'codex', mode: 'move', nativeMode: 'handoff', relayUrl: `ws://127.0.0.1:${relay.address().port}` };
  const configs = [0, 1].map(i => ({ ...common, role: i ? 'destination' : 'source', ticket: i ? 'destination' : 'source', peerPublicKey: Buffer.from(keys[1-i].publicKey).toString('base64') }));
  t.after(async () => { source.close(); destination.close(); for (const p of relay.clients) p.terminate(); await new Promise(resolve => relay.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  return {
    configs, jobId, hooks,
    get source() { return source; }, get destination() { return destination; },
    pauseMidway() { stopAtChunk = true; },
    loseReceipt() { stopAfterImport = true; },
    get receiptLost() { return receiptLost; },
    get counts() { return { exports, imports, archives }; },
    get pausedBytes() { return persistedBytes; },
    async restart() { await delay(50); create(); interrupt = false; source.resume(); destination.resume(); },
    verify() { assert.equal(exports, 1); assert.equal(imports, 1); assert.equal(archives, 1); assert.equal(observedPlaintext, false); },
  };
}

test('server transfer resumes after both processes stop mid-chunk with no phone and one import', async t => {
  const f = await fixture(t); f.pauseMidway();
  f.destination.start(f.configs[1]); f.source.start(f.configs[0]);
  await until(() => f.pausedBytes > 0);
  const savedOffset = f.pausedBytes;
  await f.restart();
  assert.ok(f.destination.status(f.jobId).bytes >= savedOffset);
  await until(() => f.source.status(f.jobId)?.phase === 'completed');
  f.source.start(f.configs[0]); f.destination.start(f.configs[1]);
  await delay(100);
  f.verify();
  assert.equal(f.destination.status(f.jobId).phase, 'completed');
});

test('retry cannot substitute a destination key or import options', async t => {
  const f = await fixture(t);
  f.destination.start(f.configs[1]);
  assert.throws(() => f.destination.start({ ...f.configs[1], targetCwd: '/another-project' }), /another operation/);
  assert.throws(() => f.destination.start({ ...f.configs[1], peerPublicKey: Buffer.from(generateKeyPair().publicKey).toString('base64') }), /another operation/);
});


test('lost import receipt survives restart without importing or archiving twice', async t => {
  const f = await fixture(t); f.loseReceipt();
  f.destination.start(f.configs[1]); f.source.start(f.configs[0]);
  await until(() => f.receiptLost);
  assert.equal(f.counts.archives, 0);
  await f.restart();
  await until(() => f.source.status(f.jobId)?.phase === 'completed');
  f.verify();
});

test('wrong server identity cannot decrypt a transfer or cause source archival', async t => {
  const f = await fixture(t);
  f.destination.start({ ...f.configs[1], peerPublicKey: Buffer.from(generateKeyPair().publicKey).toString('base64') });
  f.source.start(f.configs[0]);
  await until(() => f.destination.status(f.jobId)?.phase === 'failed');
  assert.equal(f.counts.imports, 0);
  assert.equal(f.counts.archives, 0);
});

test('destination failure is reported to source and retry reuses the completed bytes', async t => {
  const f = await fixture(t);
  const originalImport = f.hooks.import;
  f.hooks.import = async () => { throw new Error('Destination disk full'); };
  f.destination.start(f.configs[1]); f.source.start(f.configs[0]);
  await until(() => f.source.status(f.jobId)?.phase === 'failed');
  assert.match(f.source.status(f.jobId).error, /disk full/);
  const received = f.destination.status(f.jobId).bytes;
  assert.ok(received > 0); assert.equal(f.counts.archives, 0);
  f.hooks.import = originalImport;
  await delay(100);
  f.destination.start(f.configs[1]); f.source.start(f.configs[0]);
  await until(() => f.source.status(f.jobId)?.phase === 'completed');
  assert.equal(f.destination.status(f.jobId).bytes, received);
  f.verify();
});

test('same-computer transfer completes without opening a relay connection', async t => {
  const f = await fixture(t);
  f.source.start({ ...f.configs[0], role: 'local', relayUrl: undefined, ticket: undefined, peerPublicKey: undefined });
  await until(() => f.source.status(f.jobId)?.phase === 'completed');
  f.verify();
});
