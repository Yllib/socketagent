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
/**
 * @param {import("node:test").TestContext} t
 * @param {{ legacyTransport?: boolean }} options `legacyTransport` false builds both computers with the old path off.
 */
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-job-test-'));
  const relay = new WebSocketServer({ port: 0 });
  await new Promise(resolve => relay.once('listening', resolve));
  /** @type {Map<string, WebSocket>} */
  const peers = new Map();
  let interrupt = false;
  let observedPlaintext = false;
  /** The first 24 bytes of every frame each side sent, in order. */
  /** @type {{ role: string, head: Buffer }[]} */
  const frames = [];
  relay.on('connection', (socket, req) => {
    const role = (req.headers.authorization || '').replace('Bearer ', '');
    peers.set(role, socket);
    const other = role === 'source' ? 'destination' : 'source';
    if (peers.has(other)) for (const peer of peers.values()) peer.send(JSON.stringify({ type: 'peer_ready' }));
    socket.on('message', (bytes, binary) => {
      assert.equal(binary, true);
      const raw = Buffer.isBuffer(bytes) ? bytes : Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes);
      observedPlaintext ||= raw.includes(Buffer.from('transferLineage'));
      frames.push({ role, head: Buffer.from(raw.subarray(0, 24)) });
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
    source = new SessionTransferJobs(path.join(directory, 'source'), keys[0], hooks, { serverVersion: '1.1.531', ...options });
    destination = new SessionTransferJobs(path.join(directory, 'destination'), keys[1], hooks, { serverVersion: '1.1.531', ...options });
  };
  create();
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  /** @type {Omit<import("#server/protocol").TransferJobConfig, "role">} */
  const common = { jobId, sessionId: 'session-one', targetCwd: directory, targetBackend: 'codex', mode: 'move', nativeMode: 'handoff', relayUrl: `ws://127.0.0.1:${address.port}` };
  /** @type {import("#server/protocol").TransferJobConfig[]} */
  const configs = [0, 1].map(i => ({ ...common, role: i ? 'destination' : 'source', ticket: i ? 'destination' : 'source', peerPublicKey: Buffer.from(keys[1-i].publicKey).toString('base64') }));
  t.after(async () => { source.close(); destination.close(); for (const p of relay.clients) p.terminate(); await new Promise(resolve => relay.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  /** The same two start messages with one transfer secret in both, as the app sends them when both computers are new. */
  const transferSecret = crypto.randomBytes(32).toString('base64');
  const secretConfigs = configs.map(config => ({ ...config, transferSecret }));
  return {
    configs, secretConfigs, frames, jobId, hooks, directory,
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

/** A v2 record starts with its direction byte and fifteen zero bytes. A static-box nonce is random. */
function isV2Record(/** @type {Buffer} */ head) {
  return (head[0] === 1 || head[0] === 2) && head.subarray(1, 16).every(byte => byte === 0);
}

test('a job with a transfer secret runs on a v2 handshake, resumes mid-chunk, and sends no static-box frame', async t => {
  const f = await fixture(t); f.pauseMidway();
  f.destination.start(f.secretConfigs[1]); f.source.start(f.secretConfigs[0]);
  await until(() => f.pausedBytes > 0);
  await f.restart();
  await until(() => f.source.status(f.jobId)?.phase === 'completed');
  await until(() => f.destination.status(f.jobId)?.phase === 'completed');
  f.verify();

  // The source opens with the binary hs1, the destination answers with hs2, and the rest are records.
  const from = (/** @type {string} */ role) => f.frames.filter(frame => frame.role === role).map(frame => frame.head);
  assert.deepEqual([...from('source')[0].subarray(0, 2)], [0x48, 0x01]);
  assert.deepEqual([...from('destination')[0].subarray(0, 2)], [0x48, 0x02]);
  const records = f.frames.filter(frame => frame.head[0] !== 0x48);
  assert.ok(records.length > 10);
  assert.equal(records.every(frame => isV2Record(frame.head)), true);
  assert.equal(records.filter(frame => frame.role === 'source').every(frame => frame.head[0] === 1), true);
  // The secret is not in what the app is told about the job.
  assert.equal(JSON.stringify(f.source.list()).includes(String(f.secretConfigs[0].transferSecret)), false);
  // A retry may not swap the secret.
  assert.throws(() => f.source.start({ ...f.secretConfigs[0], transferSecret: crypto.randomBytes(32).toString('base64') }), /another operation/);
});

test('a transfer handshake from a key that is not the job\'s peerPublicKey gets no answer', async t => {
  const f = await fixture(t);
  // The destination was told to expect another computer. The secret is the same on both.
  f.destination.start({ ...f.secretConfigs[1], peerPublicKey: Buffer.from(generateKeyPair().publicKey).toString('base64') });
  f.source.start(f.secretConfigs[0]);
  await until(() => f.frames.some(frame => frame.role === 'source'));
  await delay(300);
  assert.deepEqual(f.frames.filter(frame => frame.role === 'destination'), [], 'the destination stays silent');
  assert.deepEqual(f.frames.filter(frame => frame.role === 'source').map(frame => [...frame.head.subarray(0, 2)]), [[0x48, 0x01]], 'the source sent hs1 and nothing after it');
  assert.equal(f.counts.imports, 0);
  assert.equal(f.counts.archives, 0);
  assert.equal(f.destination.status(f.jobId)?.bytes, 0);
});

test('a transfer handshake that proves another secret gets no answer', async t => {
  const f = await fixture(t);
  f.destination.start({ ...f.secretConfigs[1], transferSecret: crypto.randomBytes(32).toString('base64') });
  f.source.start(f.secretConfigs[0]);
  await until(() => f.frames.some(frame => frame.role === 'source'));
  await delay(300);
  assert.deepEqual(f.frames.filter(frame => frame.role === 'destination'), []);
  assert.equal(f.counts.imports, 0);
});

test('a job with a transfer secret takes no static-box frame', async t => {
  const f = await fixture(t);
  // The destination has no secret, so everything it sends is in the static box.
  f.destination.start(f.configs[1]);
  f.source.start(f.secretConfigs[0]);
  // It cannot read hs1, fails its own job and says so in a static-box frame.
  await until(() => f.destination.status(f.jobId)?.phase === 'failed');
  await until(() => f.frames.some(frame => frame.role === 'destination'));
  await delay(200);
  // On the old path that frame fails the source's job. Here it is not opened.
  assert.notEqual(f.source.status(f.jobId)?.phase, 'failed');
  assert.equal(f.source.status(f.jobId)?.bytes, 0);
  assert.equal(f.frames.filter(frame => frame.role === 'source' && frame.head[0] !== 0x48).length, 0, 'the source sent no record');
  assert.equal(f.counts.imports, 0);
  assert.equal(f.counts.archives, 0);
});

test('with the old path off a transfer between computers needs a transfer secret', async t => {
  const f = await fixture(t, { legacyTransport: false });
  assert.throws(() => f.source.start(f.configs[0]), /Update both computers/);
  assert.throws(() => f.destination.start(f.configs[1]), /Update both computers/);
  assert.deepEqual(f.source.list(), []);

  // A job this computer accepted before the switch was turned off stops when it is picked up again.
  const folder = path.join(f.directory, 'earlier');
  const before = new SessionTransferJobs(folder, generateKeyPair(), f.hooks);
  before.start(f.configs[1]);
  before.close();
  const after = new SessionTransferJobs(folder, generateKeyPair(), f.hooks, { legacyTransport: false });
  t.after(() => after.close());
  after.resume();
  await until(() => after.status(f.jobId)?.phase === 'failed');
  assert.match(after.status(f.jobId)?.error ?? '', /old transport/);
  assert.equal(f.frames.length, 0);

  // With the secret the same two computers transfer, and a same-computer transfer never needed one.
  f.destination.start(f.secretConfigs[1]); f.source.start(f.secretConfigs[0]);
  await until(() => f.source.status(f.jobId)?.phase === 'completed');
  f.verify();
});
