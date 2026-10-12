const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const { DeviceRegistry } = require("#server/device-registry");
const { ComputerLinkPeerApi, requestDigest, canonicalJson, CHALLENGE_TTL_MS } = require("#server/computer-link-peer");
const { generateKeyPair, encrypt, toBase64 } = require("#server/relay-crypto");

let counter = 0;

/** @param {{ confirm?: "every_time" | "per_chat" | "never", commands?: boolean }} options */
function setup(options = {}) {
  const registry = new DeviceRegistry(path.join(dataDir, `peer-registry-${++counter}.json`), true);
  const target = generateKeyPair();
  const source = generateKeyPair();
  const device = generateKeyPair();
  const sourceKey = toBase64(source.publicKey);
  registry.enroll({ publicKey: sourceKey, kind: "computer", name: "Dev VM", platform: "computer", via: "link",
    access: { read: true, agents: true, commands: options.commands ?? true }, confirm: options.confirm ?? "every_time" });
  registry.enroll({ publicKey: toBase64(device.publicKey), kind: "device", name: "Pixel", platform: "android", via: "token" });
  /** @type {string[]} */
  const ran = [];
  let now = 1_760_000_000_000;
  const api = new ComputerLinkPeerApi(registry, target, {
    serverName: () => "Desktop",
    backends: () => ["claude"],
    listSessions: () => [],
    readTranscript: () => { throw new Error("unused"); },
    searchTranscripts: async () => [],
    runCommand: async (request) => {
      ran.push(request.command);
      return { exitCode: 0, stdout: "ok\n", stderr: "", truncated: false, timedOut: false };
    },
    agent: async () => { throw new Error("unused"); },
    ackAgentReport: () => {},
  }, () => now);
  return {
    registry, api, target, source, device, sourceKey, ran,
    advance: (/** @type {number} */ ms) => { now += ms; },
    now: () => now,
    /**
     * @param {Record<string, unknown>} claims
     * @param {ReturnType<typeof generateKeyPair>} signer
     */
    token(claims, signer = device) {
      const box = encrypt(JSON.stringify(claims), target.publicKey, signer.secretKey);
      return { from: toBase64(signer.publicKey), n: box.n, c: box.c };
    },
  };
}

const request = { type: "peer_request", id: "r1", action: "run_command", args: { command: "echo hi" }, sourceSessionId: "chat-1" };

/** @param {ReturnType<typeof setup>} env */
async function challenge(env) {
  const response = await env.api.handle(request, env.sourceKey);
  assert.ok(response?.approvalRequired, "expected an approval challenge");
  const pending = response.approvalRequired;
  assert.equal(pending.action, "run_command");
  assert.equal(pending.summary, "echo hi");
  assert.equal(pending.digest, requestDigest({
    action: "run_command", args: { command: "echo hi" }, sourceSessionId: "chat-1",
    sourceKey: env.sourceKey, challengeId: pending.challengeId,
  }));
  return pending;
}

/** @param {ReturnType<typeof setup>} env @param {{challengeId: string, digest: string}} pending */
function claims(env, pending, overrides = {}) {
  return {
    digest: pending.digest, challengeId: pending.challengeId, scope: "once",
    sourceSessionId: "chat-1", sourceKey: env.sourceKey, expiresAt: env.now() + 60_000,
    ...overrides,
  };
}

test("canonical JSON sorts keys so both sides hash the same bytes", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: null, c: "x" }], e: undefined }), '{"a":[{"c":"x","d":null}],"b":1}');
});

test("a correct approval runs the command once and a replay is refused", async () => {
  const env = setup();
  const pending = await challenge(env);
  const approval = env.token(claims(env, pending));
  const ok = await env.api.handle({ ...request, approval }, env.sourceKey);
  assert.equal(ok?.ok, true);
  assert.deepEqual(env.ran, ["echo hi"]);

  const replay = await env.api.handle({ ...request, approval }, env.sourceKey);
  assert.equal(replay?.ok, false);
  assert.equal(replay?.code, "approval_invalid");
  assert.deepEqual(env.ran, ["echo hi"]);
});

test("approvals from the wrong sender are refused", async () => {
  const env = setup();
  const pending = await challenge(env);
  const stranger = generateKeyPair();
  const fromStranger = await env.api.handle({ ...request, approval: env.token(claims(env, pending), stranger) }, env.sourceKey);
  assert.equal(fromStranger?.ok, false);
  assert.match(String(fromStranger?.error), /enrolled device/);

  // The source computer cannot approve its own request even though it is enrolled.
  const fromSource = await env.api.handle({ ...request, approval: env.token(claims(env, pending), env.source) }, env.sourceKey);
  assert.equal(fromSource?.ok, false);
  assert.match(String(fromSource?.error), /enrolled device/);

  // A box that claims to be from the device but was made with another key does not open.
  const forged = env.token(claims(env, pending), stranger);
  forged.from = toBase64(env.device.publicKey);
  const opened = await env.api.handle({ ...request, approval: forged }, env.sourceKey);
  assert.equal(opened?.ok, false);
  assert.match(String(opened?.error), /could not be opened/);
  assert.deepEqual(env.ran, []);
});

test("a wrong digest or a changed request is refused", async () => {
  const env = setup();
  const pending = await challenge(env);
  const wrongDigest = await env.api.handle({ ...request, approval: env.token(claims(env, pending, { digest: "00".repeat(32) })) }, env.sourceKey);
  assert.equal(wrongDigest?.ok, false);
  assert.match(String(wrongDigest?.error), /different request/);

  const changed = await env.api.handle({
    ...request, args: { command: "rm -rf /" }, approval: env.token(claims(env, pending)),
  }, env.sourceKey);
  assert.equal(changed?.ok, false);
  assert.match(String(changed?.error), /different request/);

  const otherChat = await env.api.handle({ ...request, sourceSessionId: "chat-2", approval: env.token(claims(env, pending)) }, env.sourceKey);
  assert.equal(otherChat?.ok, false);
  assert.deepEqual(env.ran, []);
});

test("expired tokens and expired challenges are refused", async () => {
  const env = setup();
  const pending = await challenge(env);
  const stale = await env.api.handle({ ...request, approval: env.token(claims(env, pending, { expiresAt: env.now() - 1 })) }, env.sourceKey);
  assert.equal(stale?.ok, false);
  assert.match(String(stale?.error), /expired/);

  env.advance(CHALLENGE_TTL_MS + 1);
  const late = await env.api.handle({ ...request, approval: env.token(claims(env, pending)) }, env.sourceKey);
  assert.equal(late?.ok, false);
  assert.match(String(late?.error), /open request/);
  assert.deepEqual(env.ran, []);
});

test("scope must fit the target's confirm setting", async () => {
  const everyTime = setup({ confirm: "every_time" });
  const pending = await challenge(everyTime);
  const chatScoped = await everyTime.api.handle({ ...request, approval: everyTime.token(claims(everyTime, pending, { scope: "chat" })) }, everyTime.sourceKey);
  assert.equal(chatScoped?.ok, false);
  assert.match(String(chatScoped?.error), /every time/);

  // Once is always fine, and under every_time the next request needs a new approval.
  const once = await everyTime.api.handle({ ...request, approval: everyTime.token(claims(everyTime, pending)) }, everyTime.sourceKey);
  assert.equal(once?.ok, true);
  const again = await everyTime.api.handle({ ...request, id: "r2" }, everyTime.sourceKey);
  assert.ok(again?.approvalRequired);

  const perChat = setup({ confirm: "per_chat" });
  const pending2 = await challenge(perChat);
  const chat = await perChat.api.handle({ ...request, approval: perChat.token(claims(perChat, pending2, { scope: "chat" })) }, perChat.sourceKey);
  assert.equal(chat?.ok, true);
  const second = await perChat.api.handle({ ...request, id: "r2", args: { command: "echo two" } }, perChat.sourceKey);
  assert.equal(second?.ok, true);
  const otherChat = await perChat.api.handle({ ...request, id: "r3", sourceSessionId: "chat-9" }, perChat.sourceKey);
  assert.ok(otherChat?.approvalRequired);
  assert.deepEqual(perChat.ran, ["echo hi", "echo two"]);
});

test("access is enforced before any approval and unknown keys get nothing", async () => {
  const env = setup({ commands: false, confirm: "never" });
  const denied = await env.api.handle(request, env.sourceKey);
  assert.equal(denied?.ok, false);
  assert.equal(denied?.code, "access_denied");
  const hello = await env.api.handle({ ...request, action: "hello", args: {} }, env.sourceKey);
  assert.equal(hello?.ok, true);
  assert.deepEqual(hello?.result, {
    name: "Desktop", access: { read: true, agents: true, commands: false }, confirm: "never",
    platform: process.platform, backends: ["claude"],
  });
  const stranger = await env.api.handle(request, toBase64(generateKeyPair().publicKey));
  assert.equal(stranger?.code, "access_denied");
  const device = await env.api.handle(request, toBase64(env.device.publicKey));
  assert.equal(device?.code, "access_denied");
  assert.deepEqual(env.ran, []);
});
