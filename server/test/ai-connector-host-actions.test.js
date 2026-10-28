const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const dataDir = require("./test-data-dir");

const { ConnectorHostActions } = require("#server/ai-connector-host-actions");
const { ComputerAccessRequests } = require("#server/computer-access-requests");
const { ComputerLinkPeerApi } = require("#server/computer-link-peer");
const { DeviceRegistry } = require("#server/device-registry");
const { generateKeyPair, encrypt, toBase64 } = require("#server/relay-crypto");
const { isRecord } = require("#server/value-guards");

/** @typedef {import("#server/protocol").ComputerAccessRequestCard} ComputerAccessRequestCard */
/** @typedef {import("#server/ai-connector-store").AiConnectorGrant} AiConnectorGrant */

let counter = 0;

/**
 * This computer hosting the connector: a registry with an enrolled phone and
 * a connector client that must ask before each action, the real card queue,
 * and the host-action runner with a short wait.
 */
function setup({ waitMs = 150 } = {}) {
  const registry = new DeviceRegistry(path.join(dataDir, `host-actions-${++counter}.json`), true);
  const serverKeys = generateKeyPair();
  const phone = generateKeyPair();
  registry.enroll({ publicKey: toBase64(phone.publicKey), kind: "device", name: "Phone", platform: "android", via: "relay", access: { read: true, agents: true, commands: true }, confirm: "never" });
  const clientKey = crypto.randomBytes(32).toString("base64");
  registry.enroll({ publicKey: clientKey, kind: "connector", name: "Claude", platform: "connector", via: "connector", access: { read: true, agents: false, commands: false }, confirm: "ask" });
  /** @type {AiConnectorGrant} */
  const grant = {
    grantId: "g1", clientId: "https://claude.ai/metadata.json", clientName: "Claude", publicKey: clientKey,
    sessionId: "connector-1", createdAt: new Date().toISOString(),
  };
  let listed = 0;
  const peerApi = new ComputerLinkPeerApi(registry, serverKeys, {
    serverName: () => "Desktop", backends: () => ["claude"],
    listSessions: () => { listed++; return [{ id: "s1", title: "T", backend: "claude", cwd: "/", updatedAt: "", running: false }]; },
    readTranscript: () => { throw new Error("unused"); }, searchTranscripts: async () => [],
    runCommand: async () => { throw new Error("unused"); }, agent: async () => { throw new Error("unused"); }, ackAgentReport: () => {},
  });
  /** @type {ComputerAccessRequestCard[]} */
  const cards = [];
  /** @type {string[]} */
  const resolved = [];
  const requests = new ComputerAccessRequests({
    broadcast: (message) => { if (message.type === "computer_access_resolved") resolved.push(message.decision); },
    appendHistory: (_sessionId, entry) => { if (entry.computerAccess) cards.push(entry.computerAccess); return entry; },
    markResolved: () => {},
  });
  /** @type {string[]} */
  const pushes = [];
  const actions = new ConnectorHostActions({
    peerApi,
    self: () => ({ name: "Desktop", publicKey: toBase64(serverKeys.publicKey) }),
    ask: (sessionId, card) => requests.ask(sessionId, card),
    notify: (_grant, summary) => { pushes.push(summary); },
    waitMs,
  });
  /** The phone taps Allow on a card: it seals the claims to this computer with its own device key. */
  const allow = (/** @type {ComputerAccessRequestCard} */ card, /** @type {"once" | "chat"} */ scope = "once") => {
    assert.equal(card.approvalKey, clientKey, "the card names the client key as the approval's source");
    const claims = { digest: card.digest, challengeId: card.challengeId, scope, sourceSessionId: grant.sessionId, sourceKey: card.approvalKey, expiresAt: Date.now() + 60_000 };
    const box = encrypt(JSON.stringify(claims), serverKeys.publicKey, phone.secretKey);
    return requests.answer({ type: "computer_access_answer", requestId: card.requestId, decision: scope, approval: { from: toBase64(phone.publicKey), n: box.n, c: box.c } });
  };
  return { registry, grant, actions, cards, pushes, resolved, allow, listed: () => listed, requests };
}

const waitingError = /Waiting for your approval on the phone/;

test("tapping Allow on the host computer's card completes the waiting tool call", async () => {
  const env = setup({ waitMs: 5_000 });
  const call = env.actions.run(env.grant, "sessions_list", { limit: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(env.cards.length, 1, "one card was raised");
  const card = env.cards[0];
  assert.equal(card.kind, "approval");
  assert.equal(card.source.name, "Desktop");
  assert.equal(card.target.publicKey, card.source.publicKey, "this computer is both source and target");
  assert.deepEqual(card.client, { name: "Claude", publicKey: env.grant.publicKey });
  assert.deepEqual(env.pushes, [card.summary.split("\n")[0].slice(0, 120)]);
  assert.equal(env.listed(), 0, "nothing ran before the answer");

  assert.equal(env.allow(card), true);
  const result = await call;
  assert.deepEqual(result, { sessions: [{ id: "s1", title: "T", backend: "claude", cwd: "/", updatedAt: "", running: false }] });
  assert.equal(env.listed(), 1);
  assert.deepEqual(env.resolved, ["once"]);
});

test("Deny on the card fails the call with the user's decision", async () => {
  const env = setup({ waitMs: 5_000 });
  const call = env.actions.run(env.grant, "sessions_list", {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  env.requests.answer({ type: "computer_access_answer", requestId: env.cards[0].requestId, decision: "deny" });
  await assert.rejects(call, /The user denied this request\./);
  assert.equal(env.listed(), 0);
});

test("an unanswered card returns quickly, and the same request after Allow collects the result", async () => {
  const env = setup({ waitMs: 150 });
  const started = Date.now();
  await assert.rejects(env.actions.run(env.grant, "sessions_list", { limit: 5 }), waitingError);
  assert.ok(Date.now() - started < 1_000, "the client is not kept waiting for the card's ten minutes");
  assert.equal(env.cards.length, 1);
  assert.deepEqual(env.resolved, [], "the card is still open");

  // The client retries while the card is still unanswered: no second card, same answer.
  await assert.rejects(env.actions.run(env.grant, "sessions_list", { limit: 5 }), waitingError);
  assert.equal(env.cards.length, 1, "a retry attaches to the open card");
  assert.equal(env.pushes.length, 1, "one push for one card");

  env.allow(env.cards[0]);
  const result = await env.actions.run(env.grant, "sessions_list", { limit: 5 });
  assert.ok(isRecord(result) && Array.isArray(result.sessions) && result.sessions.length === 1);
  assert.equal(env.listed(), 1, "the action ran once");

  // Collected once; a fresh request starts over with a new card.
  await assert.rejects(env.actions.run(env.grant, "sessions_list", { limit: 5 }), waitingError);
  assert.equal(env.cards.length, 2);
});

test("a chat-scoped Allow lets later calls in the same session skip the card", async () => {
  const env = setup({ waitMs: 5_000 });
  const first = env.actions.run(env.grant, "sessions_list", {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  env.allow(env.cards[0], "chat");
  await first;
  await env.actions.run(env.grant, "sessions_list", { limit: 2 });
  assert.equal(env.cards.length, 1, "the chat grant covered the second call");
  assert.equal(env.listed(), 2);
});

test("a client without access on this computer is told so without a card", async () => {
  const env = setup();
  await assert.rejects(env.actions.run(env.grant, "run_command", { command: "ls" }), /Claude is not allowed commands on Desktop/);
  assert.equal(env.cards.length, 0);
});

test("the wait only cuts short a call that sits on a card", async () => {
  const env = setup({ waitMs: 50 });
  // Without a card the call simply finishes, however long it takes relative to the wait.
  const slow = new ConnectorHostActions({
    peerApi: { handle: async () => { await new Promise((resolve) => setTimeout(resolve, 120)); return { type: "peer_response", id: "1", ok: true, result: "done" }; } },
    self: () => ({ name: "Desktop", publicKey: "k" }),
    ask: async () => { throw new Error("unused"); },
    waitMs: 50,
  });
  assert.equal(await slow.run(env.grant, "sessions_list", {}), "done");
});
