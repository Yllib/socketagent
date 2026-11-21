const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const nacl = require("tweetnacl");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
require("./test-data-dir");
const { saveSession } = require("#server/session-store");
const { decodeBoardSecret, deriveBoardKeys, openBoardRecord, sealBoardRecord } = require("#server/project-board-crypto");
const { ProjectBoardRelay } = require("#server/project-board-relay");
const { ProjectBoardStore, setProjectBoardStore } = require("#server/project-board-store");
const {
  commitBoardTurn,
  forgetBoardDelivery,
  handleProjectBoardTool,
  prepareBoardTurn,
} = require("#server/project-board-tool");
const { socketAgentAppToolNames } = require("#server/codex-app-mcp");
const { buildSocketAgentIntegrationInstructions } = require("#server/socketagent-instructions");
const { isRecord, parseJsonObject, unknownArray } = require("#server/value-guards");

const RELAY_URL = "wss://relay.test";

/**
 * A small stand-in for the relay's board routes (docs/project-boards.md,
 * "Relay API"). It checks every signature with Node's own Ed25519, so a
 * request this server signs wrongly fails here the way it would there.
 */
class FakeRelay {
  constructor() {
    /** @type {Map<string, { seq: number, records: Map<string, { version: number, seq: number, ciphertext: string }> }>} */
    this.boards = new Map();
    /** @type {Set<string>} */
    this.deleted = new Set();
    this.down = false;
    /** @type {number[]} statuses the next PUTs answer with instead of writing */
    this.refusePuts = [];
    /** @type {(() => Promise<void>) | null} runs once just before the next PUT is applied */
    this.beforeNextPut = null;
    this.puts = 0;
  }

  /** @param {string} boardId */
  board(boardId) {
    let board = this.boards.get(boardId);
    if (!board) {
      /** @type {Map<string, { version: number, seq: number, ciphertext: string }>} */
      const records = new Map();
      board = { seq: 0, records };
      this.boards.set(boardId, board);
    }
    return board;
  }

  /** @type {import("#server/project-board-relay").BoardFetch} */
  fetch = async (url, init) => {
    if (this.down) throw new TypeError("fetch failed");
    const parsed = new URL(url);
    const body = init.body ?? "";
    const boardId = init.headers["X-SA-Board"];
    const time = init.headers["X-SA-Time"];
    const message = ["socketagent-board-v1", init.method, parsed.pathname, time,
      crypto.createHash("sha256").update(body).digest("hex")].join("\n");
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: boardId }, format: "jwk" });
    if (!crypto.verify(null, Buffer.from(message), key, Buffer.from(init.headers["X-SA-Signature"], "base64"))) {
      return reply(401, { error: "unauthorized" });
    }
    if (this.deleted.has(boardId)) return reply(410, { error: "gone" });
    const board = this.board(boardId);
    if (init.method === "GET" && parsed.pathname === "/api/board/records") {
      const since = Number(parsed.searchParams.get("since") ?? "0");
      const records = [...board.records].filter(([, record]) => record.seq > since)
        .sort(([, a], [, b]) => a.seq - b.seq)
        .map(([id, record]) => ({ id, ...record }));
      return reply(200, { seq: board.seq, records });
    }
    const match = /^\/api\/board\/records\/(.+)$/.exec(parsed.pathname);
    if (init.method === "PUT" && match) {
      const hook = this.beforeNextPut;
      this.beforeNextPut = null;
      if (hook) await hook();
      const refusal = this.refusePuts.shift();
      if (refusal === 429) return reply(429, { error: "rate_limited" });
      if (refusal === 400) return reply(400, { error: "invalid_body" });
      const request = parseJsonObject(body);
      const current = board.records.get(match[1]);
      if (request.expectedVersion !== (current?.version ?? 0)) {
        return reply(409, { error: "conflict", version: current?.version ?? 0 });
      }
      this.puts++;
      board.seq++;
      const saved = { version: (current?.version ?? 0) + 1, seq: board.seq, ciphertext: String(request.ciphertext) };
      board.records.set(match[1], saved);
      return reply(200, { version: saved.version, seq: saved.seq });
    }
    return reply(404, { error: "not_found" });
  };
}

/** @param {number} status @param {unknown} value */
function reply(status, value) {
  return { status, text: async () => JSON.stringify(value) };
}

function secret() {
  return crypto.randomBytes(32).toString("base64");
}

/** @param {string} boardSecret */
function boardKeys(boardSecret) {
  const bytes = decodeBoardSecret(boardSecret);
  assert.ok(bytes);
  return deriveBoardKeys(bytes);
}

/** One computer: its own data folder and store, all talking to [relay]. */
/** @param {FakeRelay} relay @param {string} [dataDir] */
function computer(relay, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-boards-"))) {
  return { dataDir, store: new ProjectBoardStore({ dataDir, relayUrl: RELAY_URL, fetch: relay.fetch }) };
}

/** @param {string} title */
function chat(title) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  saveSession({ id, title, cwd: os.tmpdir(), createdAt: now, lastActive: now, messagePreview: "" });
  return id;
}

/** @param {string} projectId @param {string} boardSecret @param {string[]} sessionIds */
function grant(projectId, boardSecret, sessionIds) {
  return { projectId, name: "Mobile app", secret: boardSecret, sessionIds };
}

/**
 * Runs a tool action as [sessionId] against [store] and returns the parsed
 * JSON answer, or the error text.
 * @param {import("#server/project-board-store").ProjectBoardStore} store
 * @param {string} sessionId
 * @param {import("#server/project-board-tool").ProjectBoardToolArgs} args
 */
async function tool(store, sessionId, args) {
  setProjectBoardStore(store);
  const result = await handleProjectBoardTool({ getSessionId: () => sessionId }, args);
  const text = result.content[0].text;
  return result.isError ? { error: text } : { value: parseJsonObject(text) };
}

/** @param {{ value?: Record<string, unknown>, error?: string }} result */
function ok(result) {
  assert.equal(result.error, undefined);
  assert.ok(result.value);
  return result.value;
}

/** @param {Record<string, unknown>} value */
function cardOf(value) {
  assert.ok(isRecord(value.card));
  return value.card;
}

/** The plaintext of [recordId] as the relay holds it. */
/** @param {FakeRelay} relay @param {string} boardSecret @param {string} recordId */
function relayRecord(relay, boardSecret, recordId) {
  const keys = boardKeys(boardSecret);
  const record = relay.board(keys.boardId).records.get(recordId);
  assert.ok(record, `${recordId} is on the relay`);
  const plaintext = openBoardRecord(keys.boardKey, record.ciphertext);
  assert.ok(plaintext);
  return parseJsonObject(plaintext);
}

test("grants live in project-boards.json, mode 0600, and each message replaces them", () => {
  const relay = new FakeRelay();
  const { dataDir, store } = computer(relay);
  const s = secret();
  const kept = store.replaceGrants([
    grant("p_aa", s, ["chat-1"]),
    grant("p_bad", "not-a-secret", ["chat-2"]),
    grant("../escape", secret(), ["chat-3"]),
  ]);
  assert.deepEqual(kept, []);
  const file = path.join(dataDir, "project-boards.json");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.projectFor("chat-1"), "p_aa");
  assert.equal(store.projectFor("chat-2"), null, "a grant with a malformed secret is ignored");
  assert.equal(store.projectFor("chat-3"), null);

  const reloaded = new ProjectBoardStore({ dataDir, relayUrl: RELAY_URL, fetch: relay.fetch });
  assert.equal(reloaded.projectFor("chat-1"), "p_aa", "grants survive a restart");
  reloaded.replaceGrants([]);
  assert.equal(reloaded.projectFor("chat-1"), null, "an empty list drops every board");
  assert.equal(reloaded.heldKey("p_aa"), s, "but the computer keeps the key for the app to ask back");
  const again = new ProjectBoardStore({ dataDir, relayUrl: RELAY_URL, fetch: relay.fetch });
  assert.equal(again.heldKey("p_aa"), s, "held keys survive a restart");
  assert.equal(again.heldKey("p_none"), undefined);
});

test("a child agent joins its parent's project until the app's grant lists it", () => {
  const { store } = computer(new FakeRelay());
  const s = secret();
  store.replaceGrants([grant("p_aa", s, ["parent"])]);
  assert.equal(store.projectFor("", "p_aa"), "p_aa", "a child without an ID uses its hint");
  assert.equal(store.addMember("p_aa", "child"), true);
  assert.equal(store.addMember("p_none", "child-2"), false);
  assert.equal(store.projectFor("child"), "p_aa");
  assert.equal(store.projectFor("child", "p_other"), "p_aa", "once the child has an ID the hint no longer counts");
  assert.deepEqual(store.replaceGrants([grant("p_aa", s, ["parent"])]), [{ projectId: "p_aa", sessionId: "child" }],
    "a grant without the child asks for the notice again");
  assert.equal(store.projectFor("child"), "p_aa", "the child keeps the board while the app files it");
  assert.deepEqual(store.replaceGrants([grant("p_aa", s, ["parent"])]), [], "only once");
  assert.equal(store.projectFor("child"), null, "after that the grant wins, so a move the user made sticks");
  store.addMember("p_aa", "child-3");
  assert.deepEqual(store.replaceGrants([grant("p_aa", s, ["parent", "child-3"])]), []);
  assert.equal(store.projectFor("child-3"), "p_aa");
});

test("a card made in one chat reaches another computer, with detail only from get", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const writer = chat("Release prep");
  const a = computer(relay);
  const b = computer(relay);
  a.store.replaceGrants([grant("p_app", s, [writer])]);
  b.store.replaceGrants([grant("p_app", s, ["other-chat"])]);

  const missingAsk = await tool(a.store, writer, { action: "create", title: "Approve 1.4 notes", status: "needs_you" });
  assert.match(missingAsk.error ?? "", /needs an ask/);
  const unknownStatus = await tool(a.store, writer, { action: "create", title: "x", status: "nope" });
  assert.match(unknownStatus.error ?? "", /Unknown status "nope"/);
  assert.equal(relay.puts, 0, "refused cards never reach the relay");

  const detail = "## Proposed release notes\n\nThe full text the user approves from the card.";
  const created = cardOf(ok(await tool(a.store, writer, {
    action: "create",
    title: "Approve 1.4 notes",
    status: "needs_you",
    notes: "Drafted",
    detail,
    ask: { kind: "approve", text: "Ship these release notes with 1.4?" },
  })));
  const cardId = String(created.id);
  const stored = relayRecord(relay, s, `card.${cardId}`);
  assert.equal(stored.v, 1);
  assert.equal(stored.detail, detail);
  assert.deepEqual(stored.ask, { kind: "approve", text: "Ship these release notes with 1.4?", sessionId: writer });
  const history = unknownArray(stored.history);
  assert.equal(history.length, 1);
  assert.ok(isRecord(history[0]));
  assert.equal(history[0].by, "Release prep", "history names the chat by its title");

  const listed = ok(await tool(b.store, "other-chat", { action: "list", kind: "user" }));
  const cards = unknownArray(listed.cards);
  assert.equal(cards.length, 1);
  assert.ok(isRecord(cards[0]));
  assert.equal(cards[0].title, "Approve 1.4 notes");
  assert.equal(cards[0].detail, undefined, "list leaves detail out");
  assert.equal(cards[0].detailBytes, Buffer.byteLength(detail));

  const full = ok(await tool(b.store, "other-chat", { action: "get", card_id: cardId }));
  assert.equal(full.detail, detail);

  const tooBig = await tool(a.store, writer, { action: "update", card_id: cardId, detail: "x".repeat(48 * 1024 + 1) });
  assert.match(tooBig.error ?? "", /48 KiB/);

  const cleared = await tool(a.store, writer, { action: "update", card_id: cardId, ask: null });
  assert.match(cleared.error ?? "", /needs an ask/, "a card waiting on the user keeps its ask");
});

test("a 409 re-reads the card and applies the agent's change again", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const first = chat("Support inbox");
  const second = chat("Ticket 812");
  const a = computer(relay);
  const b = computer(relay);
  a.store.replaceGrants([grant("p_app", s, [first])]);
  b.store.replaceGrants([grant("p_app", s, [second])]);
  const cardId = String(cardOf(ok(await tool(a.store, first, { action: "create", title: "Refund request", status: "inbox" }))).id);
  await b.store.board("p_app")?.sync();

  // Another chat moves the card between this chat's pull and its write.
  relay.beforeNextPut = async () => {
    ok(await tool(a.store, first, { action: "move", card_id: cardId, status: "doing", why: "Looking at it" }));
  };
  ok(await tool(b.store, second, { action: "update", card_id: cardId, notes: "Customer replied" }));
  const merged = relayRecord(relay, s, `card.${cardId}`);
  assert.equal(merged.status, "doing", "the other chat's move survives");
  assert.equal(merged.notes, "Customer replied", "this chat's edit is applied on top");

  // A move that raced a different move no longer fits, and says who moved it.
  relay.beforeNextPut = async () => {
    ok(await tool(a.store, first, { action: "move", card_id: cardId, status: "waiting", why: "Asked the customer" }));
  };
  const lost = await tool(b.store, second, { action: "move", card_id: cardId, status: "done", why: "Refunded" });
  assert.match(lost.error ?? "", /moved from Doing \(doing\) to Waiting \(waiting\) by Support inbox/);
  assert.equal(relayRecord(relay, s, `card.${cardId}`).status, "waiting");

  // A deletion wins over a later edit.
  ok(await tool(a.store, first, { action: "delete", card_id: cardId }));
  const tombstone = relayRecord(relay, s, `card.${cardId}`);
  assert.equal(tombstone.deleted, true);
  assert.ok(typeof tombstone.updatedAt === "number" && tombstone.updatedAt > 0, "a tombstone carries the deletion time");
  const late = await tool(b.store, second, { action: "update", card_id: cardId, notes: "too late" });
  assert.match(late.error ?? "", /was deleted/);
});

test("writes wait in the outbox while the relay is down and survive a restart", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const writer = chat("Night sweep");
  const a = computer(relay);
  a.store.replaceGrants([grant("p_app", s, [writer])]);
  relay.down = true;
  const saved = ok(await tool(a.store, writer, { action: "create", title: "Check the deploy", status: "doing" }));
  assert.match(String(saved.message), /Saved on this computer/);
  const listed = ok(await tool(a.store, writer, { action: "list" }));
  assert.equal(unknownArray(listed.cards).length, 1, "the chat sees its own queued card");
  assert.match(String(listed.offline), /1 unsent change/);
  a.store.board("p_app")?.close();

  const restarted = computer(relay, a.dataDir);
  relay.down = false;
  const state = await restarted.store.board("p_app")?.sync();
  assert.deepEqual(state, { online: true, pending: 0 });
  assert.equal(relay.puts, 1);
  const [recordId] = [...relay.board(boardKeys(s).boardId).records.keys()];
  assert.equal(relayRecord(relay, s, recordId).title, "Check the deploy");
});

test("relay refusals reach the agent as tool errors and nothing is queued", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const writer = chat("Busy chat");
  const a = computer(relay);
  a.store.replaceGrants([grant("p_app", s, [writer])]);
  relay.refusePuts.push(429);
  const limited = await tool(a.store, writer, { action: "create", title: "One", status: "inbox" });
  assert.match(limited.error ?? "", /429 \(rate_limited\)/);
  relay.refusePuts.push(400);
  const invalid = await tool(a.store, writer, { action: "create", title: "Two", status: "inbox" });
  assert.match(invalid.error ?? "", /invalid_body/);
  assert.deepEqual(await a.store.board("p_app")?.sync(), { online: true, pending: 0 });
  assert.equal(relay.puts, 0);
});

test("a board the relay answers 410 for is dropped until a new secret arrives", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const writer = chat("Old board chat");
  const a = computer(relay);
  a.store.replaceGrants([grant("p_app", s, [writer])]);
  relay.down = true;
  ok(await tool(a.store, writer, { action: "create", title: "Queued before the rotation", status: "inbox" }));
  relay.down = false;
  relay.deleted.add(boardKeys(s).boardId);
  const result = await tool(a.store, writer, { action: "create", title: "Lost", status: "inbox" });
  assert.match(result.error ?? "", /no longer available/);
  assert.equal(a.store.projectFor(writer), null);
  a.store.replaceGrants([grant("p_app", s, [writer])]);
  assert.equal(a.store.projectFor(writer), null, "the stale secret stays dropped");

  const rotated = secret();
  a.store.replaceGrants([grant("p_app", rotated, [writer])]);
  assert.equal(a.store.projectFor(writer), "p_app");
  assert.deepEqual(await a.store.board("p_app")?.sync(), { online: true, pending: 0 });
  const [recordId] = [...relay.board(boardKeys(rotated).boardId).records.keys()];
  assert.equal(relayRecord(relay, rotated, recordId).title, "Queued before the rotation",
    "a change queued for the old board reaches the new one");
});

test("board rules reach a chat once per change and again after it forgets them", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const session = chat("Rules chat");
  const a = computer(relay);
  setProjectBoardStore(a.store);
  a.store.replaceGrants([grant("p_app", s, [session])]);

  const first = await prepareBoardTurn(session, null, null);
  assert.equal(first.replacesTaskBatch, true);
  assert.ok(first.block);
  assert.match(first.block, /^<socketagent_project_board>/);
  assert.match(first.block, /needs_you: "Needs you", kind user/);
  assert.match(first.block, /full drafted message/);
  commitBoardTurn(session, first.digest);
  assert.equal((await prepareBoardTurn(session, null, null)).block, null);

  // The user changes the rules in the app.
  const keys = boardKeys(s);
  const config = { v: 1, statuses: [{ key: "triage", name: "Triage", kind: "new", meaning: "" }, { key: "ask", name: "Ask me", kind: "user", meaning: "" }],
    rules: "Make a card for every ticket.", updatedAt: Date.now(), updatedBy: "Phone" };
  await new ProjectBoardRelay("https://relay.test", keys, relay.fetch).put("config", 0, sealBoardRecord(keys.boardKey, JSON.stringify(config)));
  const changed = await prepareBoardTurn(session, null, null);
  assert.match(changed.block ?? "", /Make a card for every ticket\./);
  assert.match(changed.block ?? "", /ask: "Ask me", kind user/);
  commitBoardTurn(session, changed.digest);
  const rejected = await tool(a.store, session, { action: "create", title: "x", status: "inbox" });
  assert.match(rejected.error ?? "", /Use one of: triage, ask/);

  forgetBoardDelivery(session);
  assert.ok((await prepareBoardTurn(session, null, null)).block, "compaction or rewind delivers it again");
  commitBoardTurn(session, changed.digest);

  a.store.replaceGrants([]);
  const removed = await prepareBoardTurn(session, null, null);
  assert.equal(removed.replacesTaskBatch, false);
  assert.match(removed.block ?? "", /no longer in a project with a board/);
  commitBoardTurn(session, removed.digest);
  assert.equal((await prepareBoardTurn(session, null, null)).block, null);
});

test("proposals are written as open records and never touch the config", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const session = chat("Proposer");
  const a = computer(relay);
  a.store.replaceGrants([grant("p_app", s, [session])]);
  const duplicate = await tool(a.store, session, {
    action: "propose_rules", why: "Split waiting", rules: "r",
    statuses: [{ key: "a", name: "A", kind: "new" }, { key: "a", name: "B", kind: "done" }],
  });
  assert.match(duplicate.error ?? "", /appears twice/);
  ok(await tool(a.store, session, {
    action: "propose_rules", why: "Approved work waits for the release", rules: "New rules",
    statuses: [{ key: "inbox", name: "Inbox", kind: "new" }, { key: "approved", name: "Approved", kind: "user", meaning: "Ships next release" }],
  }));
  const records = [...relay.board(boardKeys(s).boardId).records.keys()];
  assert.equal(records.length, 1);
  assert.match(records[0], /^proposal\.r_[0-9a-f]{12}$/);
  const proposal = relayRecord(relay, s, records[0]);
  assert.equal(proposal.state, "open");
  assert.equal(proposal.byName, "Proposer");
});

/**
 * Posts an intake item the way a service does: a fresh key pair and nonce,
 * sealed to the board's box key, stored by the relay at version 1.
 * @param {FakeRelay} relay @param {string} boardSecret @param {unknown} item
 * @param {string} [ciphertext] sent as is instead of sealing [item]
 */
function postIntake(relay, boardSecret, item, ciphertext) {
  const keys = boardKeys(boardSecret);
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const box = nacl.box(new Uint8Array(Buffer.from(JSON.stringify(item), "utf8")), nonce, keys.boxKey, ephemeral.secretKey);
  const id = crypto.randomBytes(16).toString("base64url").slice(0, 22);
  const board = relay.board(keys.boardId);
  board.seq++;
  board.records.set(`intake.${id}`, {
    version: 1,
    seq: board.seq,
    ciphertext: ciphertext ?? Buffer.concat([ephemeral.publicKey, nonce, box]).toString("base64"),
  });
  return id;
}

/** @param {string} source @param {string} ref */
function intakeCard(source, ref) {
  return `h_${crypto.createHash("sha256").update(`${source}\n${ref}`).digest("hex").slice(0, 24)}`;
}

/** @param {Record<string, unknown>} fields */
function hubItem(fields) {
  return { v: 1, source: "Feedback Hub", ref: "marina#123", at: Date.now(), ...fields };
}

test("intake items open, update, close and reopen one card, and each is claimed", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const session = chat("Triage");
  const a = computer(relay);
  a.store.replaceGrants([grant("p_app", s, [session])]);
  const board = a.store.board("p_app");
  assert.ok(board);
  const cardId = intakeCard("Feedback Hub", "marina#123");
  const record = () => relayRecord(relay, s, `card.${cardId}`);

  const opened = postIntake(relay, s, hubItem({
    event: "opened", title: "Crash on launch", detail: "## Report\n\nIt crashes.", note: "New report", url: "https://hub.example/123",
  }));
  assert.deepEqual(await board.sync(), { online: true, pending: 0 });
  let card = record();
  assert.equal(card.status, "inbox");
  assert.equal(card.title, "Crash on launch");
  assert.equal(card.detail, "## Report\n\nIt crashes.");
  assert.equal(card.notes, "New report");
  assert.deepEqual(card.links, [{ kind: "ticket", ref: "https://hub.example/123", label: "Feedback Hub marina#123" }]);
  assert.deepEqual(card.intake, [opened]);
  const created = unknownArray(card.history)[0];
  assert.ok(isRecord(created));
  assert.equal(created.by, "Feedback Hub");
  const claim = relayRecord(relay, s, `intake.${opened}`);
  assert.equal(relay.board(boardKeys(s).boardId).records.get(`intake.${opened}`)?.version, 2);
  assert.equal(claim.id, opened);
  assert.equal(claim.handled, true);
  assert.equal(claim.error, undefined);

  // The app adds a field this server does not know; an agent's edit keeps it and the intake list.
  const keys = boardKeys(s);
  await new ProjectBoardRelay("https://relay.test", keys, relay.fetch)
    .put(`card.${cardId}`, 1, sealBoardRecord(keys.boardKey, JSON.stringify({ ...card, labels: ["android"] })));
  ok(await tool(a.store, session, { action: "update", card_id: cardId, notes: "Looking at the logs" }));
  card = record();
  assert.equal(card.notes, "Looking at the logs");
  assert.deepEqual(card.labels, ["android"]);
  assert.deepEqual(card.intake, [opened]);

  const updated = postIntake(relay, s, hubItem({ event: "updated", title: "Crash on launch on Android 15", note: "Customer added logs" }));
  await board.sync();
  card = record();
  assert.equal(card.title, "Crash on launch on Android 15");
  assert.equal(card.detail, "## Report\n\nIt crashes.", "a field the item leaves out is unchanged");
  assert.equal(card.notes, "Customer added logs");
  assert.equal(card.status, "inbox");
  assert.deepEqual(card.labels, ["android"]);

  const closed = postIntake(relay, s, hubItem({ event: "closed", note: "Fixed in 1.4" }));
  await board.sync();
  card = record();
  assert.equal(card.status, "done");
  const move = unknownArray(card.history).at(-1);
  assert.ok(isRecord(move));
  assert.deepEqual({ by: move.by, from: move.from, to: move.to, why: move.why },
    { by: "Feedback Hub", from: "inbox", to: "done", why: "Fixed in 1.4" });

  const reopened = postIntake(relay, s, hubItem({ event: "reopened", note: "Still crashing" }));
  await board.sync();
  card = record();
  assert.equal(card.status, "inbox");
  assert.equal(card.notes, "Still crashing");
  assert.deepEqual(card.intake, [opened, updated, closed, reopened]);
  for (const id of [updated, closed, reopened]) assert.equal(relayRecord(relay, s, `intake.${id}`).handled, true);

  const listed = ok(await tool(a.store, session, { action: "list" }));
  const cards = unknownArray(listed.cards);
  assert.equal(cards.length, 1, "claimed intake records are not cards");
  assert.ok(isRecord(cards[0]));
  assert.equal(cards[0].id, cardId);
});

test("a saved answer survives an agent's edit, reaches agents once sent, and goes with its ask", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const session = chat("Release chat");
  const a = computer(relay);
  a.store.replaceGrants([grant("p_app", s, [session])]);
  const id = String(cardOf(ok(await tool(a.store, session, {
    action: "create", title: "Ship 1.4", status: "needs_you", ask: { kind: "approve", text: "Ship 1.4 tonight?" },
  }))).id);
  const keys = boardKeys(s);
  const app = new ProjectBoardRelay("https://relay.test", keys, relay.fetch);
  /** Writes [reply] on the card the way the app does. @param {Record<string, unknown>} reply */
  const answer = async (reply) => {
    const record = relay.board(keys.boardId).records.get(`card.${id}`);
    assert.ok(record);
    const card = relayRecord(relay, s, `card.${id}`);
    await app.put(`card.${id}`, record.version, sealBoardRecord(keys.boardKey, JSON.stringify({ ...card, reply })));
  };
  /** The card as list shows it to an agent. */
  const listed = async () => {
    const cards = unknownArray(ok(await tool(a.store, session, { action: "list" })).cards);
    const card = cards.find((c) => isRecord(c) && c.id === id);
    assert.ok(isRecord(card));
    return card;
  };

  await answer({ approved: true, text: "After 6pm", at: 1 });
  ok(await tool(a.store, session, { action: "update", card_id: id, notes: "Built" }));
  assert.deepEqual(relayRecord(relay, s, `card.${id}`).reply, { approved: true, text: "After 6pm", at: 1 });
  assert.equal((await listed()).reply, undefined, "a saved answer stays private until sent");

  await answer({ approved: true, text: "After 6pm", at: 1, sentAt: 2 });
  assert.deepEqual((await listed()).reply, { approved: true, text: "After 6pm", sentAt: new Date(2).toISOString() });

  ok(await tool(a.store, session, { action: "update", card_id: id, ask: { kind: "approve", text: "Ship 1.4.1 instead?" } }));
  assert.equal(relayRecord(relay, s, `card.${id}`).reply, undefined, "a new question clears the old answer");
});

test("a Hub item lands on the card an agent already made for its ticket, and create refuses a second", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const session = chat("Triage");
  const a = computer(relay);
  a.store.replaceGrants([grant("p_app", s, [session])]);
  const link = { kind: "ticket", ref: "https://hub.example/123/", label: "Hub 123" };
  const made = cardOf(ok(await tool(a.store, session, { action: "create", title: "Crash", status: "doing", links: [link] })));
  const again = await tool(a.store, session, { action: "create", title: "Crash again", links: [{ ...link, ref: "https://hub.example/123" }] });
  assert.match(again.error ?? "", new RegExp(`${made.id}.*already tracks this ticket`));

  const opened = postIntake(relay, s, hubItem({ event: "opened", title: "Crash on launch", url: "https://hub.example/123" }));
  await a.store.board("p_app")?.sync();
  const card = relayRecord(relay, s, `card.${made.id}`);
  assert.equal(card.title, "Crash on launch");
  assert.equal(card.status, "doing", "an opened item doesn't move an adopted card");
  assert.deepEqual(card.intake, [opened]);
  assert.equal(relay.board(boardKeys(s).boardId).records.has(`card.${intakeCard("Feedback Hub", "marina#123")}`), false);
});

test("two computers handling the same intake item change the card once", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const a = computer(relay);
  const b = computer(relay);
  a.store.replaceGrants([grant("p_app", s, ["chat-a"])]);
  b.store.replaceGrants([grant("p_app", s, ["chat-b"])]);
  const id = postIntake(relay, s, hubItem({ event: "opened", title: "Dark mode request" }));

  // Computer B handles the item between A's pull and A's write of the card.
  relay.beforeNextPut = async () => {
    await b.store.board("p_app")?.sync();
  };
  assert.deepEqual(await a.store.board("p_app")?.sync(), { online: true, pending: 0 });
  const records = relay.board(boardKeys(s).boardId).records;
  const cardId = intakeCard("Feedback Hub", "marina#123");
  assert.equal(records.get(`card.${cardId}`)?.version, 1, "A's write met a 409 and found the item already applied");
  assert.equal(records.get(`intake.${id}`)?.version, 2, "claimed once");
  assert.equal(relay.puts, 2);
  const card = relayRecord(relay, s, `card.${cardId}`);
  assert.deepEqual(card.intake, [id]);
  assert.equal(unknownArray(card.history).length, 1);
});

test("an intake item that does not open or parse is claimed with an error and makes no card", async () => {
  const relay = new FakeRelay();
  const s = secret();
  const a = computer(relay);
  a.store.replaceGrants([grant("p_app", s, ["chat-a"])]);
  const garbage = postIntake(relay, s, null, crypto.randomBytes(120).toString("base64"));
  const noRef = postIntake(relay, s, { v: 1, source: "Feedback Hub", event: "opened", title: "x" });
  const noTitle = postIntake(relay, s, hubItem({ event: "opened" }));
  assert.deepEqual(await a.store.board("p_app")?.sync(), { online: true, pending: 0 });
  assert.match(String(relayRecord(relay, s, `intake.${garbage}`).error), /could not be opened/);
  assert.match(String(relayRecord(relay, s, `intake.${noRef}`).error), /ref/);
  assert.match(String(relayRecord(relay, s, `intake.${noTitle}`).error), /needs a title/);
  for (const id of [garbage, noRef, noTitle]) assert.equal(relayRecord(relay, s, `intake.${id}`).handled, true);
  const ids = [...relay.board(boardKeys(s).boardId).records.keys()];
  assert.equal(ids.filter((recordId) => recordId.startsWith("card.")).length, 0);
});

test("board chats get ProjectBoard in place of TaskBatch, unless there is no relay", async () => {
  assert.deepEqual(socketAgentAppToolNames({ projectBoard: true, taskBatch: false }).filter((name) => ["TaskBatch", "ProjectBoard"].includes(name)), ["ProjectBoard"]);
  assert.deepEqual(socketAgentAppToolNames({ projectBoard: false, taskBatch: true }).filter((name) => ["TaskBatch", "ProjectBoard"].includes(name)), ["TaskBatch"]);
  const guidance = buildSocketAgentIntegrationInstructions({ mcpServerName: "app", toolNames: ["ProjectBoard"], secureInventory: "" });
  assert.match(guidance, /-> ProjectBoard/);
  assert.doesNotMatch(guidance, /-> TaskBatch/);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-boards-"));
  const offline = new ProjectBoardStore({ dataDir, relayUrl: undefined });
  const session = chat("No relay");
  offline.replaceGrants([grant("p_app", secret(), [session])]);
  setProjectBoardStore(offline);
  const turn = await prepareBoardTurn(session, null, null);
  assert.equal(turn.replacesTaskBatch, false);
  assert.equal(turn.block, null);
  const result = await tool(offline, session, { action: "list" });
  assert.match(result.error ?? "", /no relay configured \(RELAY_URL\)/);
});
