const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { SessionTransferJobs } = require('#server/session-transfer-jobs');
const { generateKeyPair } = require('#server/relay-crypto');
/** @returns {Promise<void>} */
const delay = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));
/** @param {() => boolean} predicate */
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for transfer');
    await delay(10);
  }
}

// A ciphertext-only relay. Neither this router nor a phone receives the server keys.
/** @param {import("node:test").TestContext} t */
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-job-test-'));
  const relay = new WebSocketServer({ port: 0 });
  await new Promise(resolve => relay.once('listening', resolve));
  /** @type {Map<string, WebSocket>} */
  const peers = new Map();
  let interrupt = false;
  let observedPlaintext = false;
  relay.on('connection', (socket, req) => {
    const role = (req.headers.authorization || '').replace('Bearer ', '');
    peers.set(role, socket);
    const other = role === 'source' ? 'destination' : 'source';
    if (peers.has(other)) for (const peer of peers.values()) peer.send(JSON.stringify({ type: 'peer_ready' }));
    socket.on('message', (bytes, binary) => {
      assert.equal(binary, true);
      const raw = Buffer.isBuffer(bytes) ? bytes : Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes);
      observedPlaintext ||= raw.includes(Buffer.from('transferLineage'));
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
  /** @type {SessionTransferJobs} */
  let source;
  /** @type {SessionTransferJobs} */
  let destination;
  let stopAtChunk = false;
  let stopAfterImport = false;
  let receiptLost = false;
  /** @type {import("#server/session-transfer").SessionTransferImportResult} */
  const result = { session: {
    id: jobId, title: 'Test', cwd: directory, createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(), messagePreview: '', backend: 'codex',
    transferLineage: {
      transferId: jobId, sourceSessionId: 'session-one', sourceBackend: 'codex',
      transferredAt: new Date().toISOString(), mode: 'move',
    },
  }, sourceSessionId: 'session-one', exactNativeResume: false };
  /** @type {ConstructorParameters<typeof SessionTransferJobs>[2]} */
  const hooks = {
    export: async () => {
      exports++;
      const bundlePath = path.join(directory, 'export.gz'); fs.writeFileSync(bundlePath, payload);
      return { bundlePath, fileName: "export.gz", fileSize: payload.length, sha256: checksum, bundleId: jobId, sessionId: "session-one", backend: "codex", cwd: directory, exactNativeAvailable: false };
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
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  /** @type {Omit<import("#server/protocol").TransferJobConfig, "role">} */
  const common = { jobId, sessionId: 'session-one', targetCwd: directory, targetBackend: 'codex', mode: 'move', nativeMode: 'handoff', relayUrl: `ws://127.0.0.1:${address.port}` };
  /** @type {import("#server/protocol").TransferJobConfig[]} */
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

test('restore progress shows while importing and clears once complete', async t => {
  const f = await fixture(t);
  /** @type {() => void} */
  let release = () => {};
  const finishImport = f.hooks.import;
  f.hooks.import = async (config, bundlePath, sha256, onProgress) => {
    onProgress(40, 100);
    await new Promise(resolve => { release = () => resolve(undefined); });
    return finishImport(config, bundlePath, sha256, onProgress);
  };
  f.source.start({ ...f.configs[0], role: 'local', relayUrl: undefined, ticket: undefined, peerPublicKey: undefined });
  await until(() => f.source.status(f.jobId)?.restoredEntries === 40);
  assert.equal(f.source.status(f.jobId)?.totalEntries, 100);
  release();
  await until(() => f.source.status(f.jobId)?.phase === 'completed');
  assert.equal(f.source.status(f.jobId)?.restoredEntries, undefined);
});
