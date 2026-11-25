const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
require("./test-data-dir");
const { FakeRelay } = require("./fake-board-relay");
const { ProjectBoardStore, setProjectBoardStore } = require("#server/project-board-store");
const boards = require("#server/ai-connector-boards");

/**
 * One computer holding two boards, and a connector client that may use the
 * boards in [allowed]. [answers] decides each approval card in turn; every
 * card is recorded in [cards].
 * @param {{ allowed?: string[], answers?: boolean[] }} [options]
 */
function setup(options = {}) {
  const relay = new FakeRelay();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socketagent-connector-boards-"));
  const store = new ProjectBoardStore({ dataDir, relayUrl: "wss://relay.test", fetch: relay.fetch });
  store.replaceGrants([
    { projectId: "wakespeed", name: "Wakespeed", secret: crypto.randomBytes(32).toString("base64"), sessionIds: [] },
    { projectId: "socketagent", name: "Socketagent", secret: crypto.randomBytes(32).toString("base64"), sessionIds: [] },
  ]);
  setProjectBoardStore(store);
  const allowed = [...options.allowed ?? ["wakespeed"]];
  const answers = [...options.answers ?? []];
  /** @type {{ action: string, summary: string }[]} */
  const cards = [];
  /** @type {import("#server/ai-connector-boards").ConnectorBoardContext} */
  const ctx = {
    clientName: "Claude",
    allowed: () => allowed,
    allow: (projectId) => { allowed.push(projectId); },
    approve: async (action, summary) => {
      cards.push({ action, summary });
      if (!(answers.shift() ?? true)) throw new Error("The user denied this request.");
    },
  };
  return { ctx, cards, allowed };
}

const slack = { kind: /** @type {const} */ ("thread"), ref: "https://rooster.slack.com/archives/C1/p1700000000", label: "Slack #wakespeed" };

test("a board not allowed yet asks once, and a denial keeps it closed", async () => {
  const env = setup({ answers: [false, true] });
  assert.deepEqual(boards.listBoards(env.ctx).boards.map((board) => [board.name, board.allowed]), [["Wakespeed", true], ["Socketagent", false]]);

  await assert.rejects(boards.listCards(env.ctx, { board: "Socketagent" }), /denied/);
  assert.deepEqual(env.allowed, ["wakespeed"]);

  await boards.listCards(env.ctx, { board: "socketagent" });
  await boards.listCards(env.ctx, { board: "Socketagent" });
  assert.deepEqual(env.cards.map((card) => card.action), ["board_access", "board_access"], "no card once allowed");
  assert.deepEqual(env.allowed, ["wakespeed", "socketagent"]);
  assert.match(env.cards[0].summary, /Socketagent board/);
});

test("add_card goes to Inbox with its source link, and the same message returns the existing card", async () => {
  const env = setup();
  const first = await boards.addCard(env.ctx, { board: "Wakespeed", title: "Ask about the fuel cell", detail: "**Dan:** can we test Friday?", source_link: slack });
  assert.equal(first.created, true);
  assert.equal(first.card?.status, "inbox");
  assert.deepEqual(first.card?.links, [{ kind: "thread", ref: slack.ref, label: "Slack #wakespeed" }]);

  const again = await boards.addCard(env.ctx, { board: "Wakespeed", title: "Duplicate", source_link: { ...slack, ref: `${slack.ref.toUpperCase()}/` } });
  assert.equal(again.created, false);
  assert.equal(again.card?.id, first.card?.id);
  assert.equal((await boards.listCards(env.ctx, { board: "Wakespeed" })).cards.length, 1);
});

test("list_cards finds a message's card by link even after it was closed long ago", async () => {
  const env = setup();
  const added = await boards.addCard(env.ctx, { board: "Wakespeed", title: "Old thread", source_link: slack });
  const cardId = added.card?.id ?? "";
  await boards.closeCard(env.ctx, { board: "Wakespeed", card_id: cardId });
  const now = Date.now;
  Date.now = () => now() + 40 * 24 * 60 * 60 * 1000;
  try {
    const all = await boards.listCards(env.ctx, { board: "Wakespeed" });
    assert.equal(all.cards.length, 0);
    assert.equal(all.hiddenOldDone, 1);
    const byLink = await boards.listCards(env.ctx, { board: "Wakespeed", link_ref: slack.ref });
    assert.deepEqual(byLink.cards.map((card) => card.id), [cardId]);
    assert.equal(byLink.cards[0].kind, "done");
  } finally {
    Date.now = now;
  }
});

test("update_card appends to the detail, adds a link once and replaces notes", async () => {
  const env = setup();
  const added = await boards.addCard(env.ctx, { board: "Wakespeed", title: "Quote", detail: "First message", source_link: slack });
  const cardId = added.card?.id ?? "";
  const reply = { kind: /** @type {const} */ ("url"), ref: "https://outlook.office.com/mail/id/AAQ1", label: "Re: Quote" };
  await boards.updateCard(env.ctx, { board: "Wakespeed", card_id: cardId, append: "Second message", add_link: reply, notes: "Waiting on Dan" });
  await boards.updateCard(env.ctx, { board: "Wakespeed", card_id: cardId, add_link: reply });

  const card = await boards.getCard(env.ctx, { board: "Wakespeed", card_id: cardId });
  assert.equal(card.detail, "First message\n\n---\n\nSecond message");
  assert.equal(card.links.length, 2);
  assert.equal(card.notes, "Waiting on Dan");
  const found = await boards.listCards(env.ctx, { board: "Wakespeed", query: "outlook.office.com" });
  assert.deepEqual(found.cards.map((entry) => entry.id), [cardId]);
});

test("move_card to a status that waits on the user needs an ask, which names no chat", async () => {
  const env = setup();
  const added = await boards.addCard(env.ctx, { board: "Wakespeed", title: "Price change", source_link: slack });
  const cardId = added.card?.id ?? "";
  await assert.rejects(boards.moveCard(env.ctx, { board: "Wakespeed", card_id: cardId, status: "needs_you", why: "Needs a price" }), /needs an ask/);
  await boards.moveCard(env.ctx, { board: "Wakespeed", card_id: cardId, status: "needs_you", why: "Needs a price", ask: { kind: "answer", text: "What price?" } });
  const card = await boards.getCard(env.ctx, { board: "Wakespeed", card_id: cardId });
  assert.equal(card.status, "needs_you");
  assert.deepEqual(card.ask, { kind: "answer", text: "What price?" });
  assert.equal(card.history.at(-1)?.by, "Claude");
});

test("delete_card asks every time, and a denial keeps the card", async () => {
  const env = setup({ answers: [false, true] });
  const added = await boards.addCard(env.ctx, { board: "Wakespeed", title: "Spam", source_link: slack });
  const cardId = added.card?.id ?? "";
  await assert.rejects(boards.deleteCard(env.ctx, { board: "Wakespeed", card_id: cardId }), /denied/);
  assert.equal((await boards.listCards(env.ctx, { board: "Wakespeed" })).cards.length, 1);
  await boards.deleteCard(env.ctx, { board: "Wakespeed", card_id: cardId });
  assert.equal((await boards.listCards(env.ctx, { board: "Wakespeed" })).cards.length, 0);
  assert.deepEqual(env.cards.map((card) => card.action), ["board_delete", "board_delete"]);
});
