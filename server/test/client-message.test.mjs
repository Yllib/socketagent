import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { parseClientMessage } from '#server/client-message';
import { RelayClient, relayPeerForMessage } from '#server/relay-client';
import { encrypt, encryptBinary, generateKeyPair, toBase64 } from '#server/relay-crypto';

test('client contracts validate nested data while preserving optional and future fields', () => {
  for (const message of [
    { type: 'prompt', text: 'hello', commandId: 'c1', initialSettings: { effort: 'future-provider-effort' } },
    { type: 'new_session' },
    { type: 'list_directory', requestId: 'legacy-browser' },
    { type: 'set_server_settings', claudeAutoCompactWindow: null },
    { type: 'update_scheduled_task', taskId: 't1', model: null, recurrence: null },
    { type: 'client_capabilities', futureCapability: { enabled: true } },
  ]) {
    assert.deepEqual(parseClientMessage(message), message);
  }
  for (const message of [
    null, [], { type: 'unknown_command' }, { type: 'prompt', text: 4 },
    { type: 'prompt', text: 'private prompt', initialSettings: { thinking: { type: 'enabled', budgetTokens: 'many' } } },
    { type: 'answer', questionId: 'q1', answers: { choice: ['wrong shape'] } },
    { type: 'secure_input_response', requestId: 'r1', value: { secret: 'must-not-be-logged' } },
    { type: 'upload_chunk_bin', uploadId: 'u1', data: { type: 'Buffer', data: [1] }, chunkIndex: 0 },
  ]) {
    assert.throws(() => parseClientMessage(message), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private prompt|must-not-be-logged/);
      return true;
    });
  }
});

test('relay validates encrypted JSON and keeps valid traffic and peer routing intact', { timeout: 10_000 }, async t => {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(() => { for (const socket of relay.clients) socket.terminate(); relay.close(); });
  await once(relay, 'listening');
  const address = relay.address();
  assert.ok(address && typeof address !== 'string');
  const serverKeys = generateKeyPair();
  const phoneKeys = generateKeyPair();
  /** @type {import('#server/protocol').ClientMessage[]} */
  const received = [];
  let finish = () => {};
  /** @type {Promise<void>} */
  const finished = new Promise(resolve => { finish = () => resolve(undefined); });
  const client = new RelayClient({
    relayUrl: `ws://127.0.0.1:${address.port}`, pairingToken: 'test', keyPair: serverKeys,
    serverCapabilities: () => ({ type: 'server_capabilities' }),
    onStatusChange() {},
    onMessage(message) { received.push(message); if (received.length === 3) finish(); },
  });
  t.after(() => client.close());
  relay.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'relay_capabilities', multiDevice: true }));
    /** @param {unknown} message */
    const sendJson = message => socket.send(JSON.stringify({
      type: 'relay_peer_message', peerId: 'phone-one', binary: false, data: JSON.stringify(message),
    }));
    sendJson({ type: 'key_exchange', pubkey: toBase64(phoneKeys.publicKey) });
    sendJson(encrypt(JSON.stringify({ type: 'prompt', text: 42 }), serverKeys.publicKey, phoneKeys.secretKey));
    sendJson(encrypt(JSON.stringify({ type: 'prompt', text: 'valid', __relayPeerId: 'forged-peer' }), serverKeys.publicKey, phoneKeys.secretKey));
    /** @param {Buffer} plaintext */
    const sendBinary = plaintext => socket.send(JSON.stringify({
      type: 'relay_peer_message', peerId: 'phone-one', binary: true,
      data: encryptBinary(plaintext, serverKeys.publicKey, phoneKeys.secretKey).toString('base64'),
    }));
    sendBinary(Buffer.concat([Buffer.from([0x4a]), Buffer.from('{"type":"answer","answers":[]}')]));
    sendBinary(Buffer.concat([Buffer.from([0x4a]), Buffer.from('{"type":"abort"}')]));
    const header = Buffer.from([0x42, 2, 0x75, 0x31, 0, 0, 0, 3]);
    sendBinary(Buffer.concat([header, Buffer.from('chunk')]));
  });
  client.connect();
  await finished;
  assert.deepEqual(received.map(message => message.type), ['prompt', 'abort', 'upload_chunk_bin']);
  assert.deepEqual(received.map(relayPeerForMessage), ['phone-one', 'phone-one', 'phone-one']);
  const chunk = received[2];
  assert.equal(chunk.type, 'upload_chunk_bin');
  if (chunk.type === 'upload_chunk_bin') {
    assert.equal(chunk.chunkIndex, 3);
    assert.equal(chunk.uploadId, 'u1');
    assert.equal(chunk.data.toString(), 'chunk');
  }
});
