import { z } from "zod";
import { projectBoards, type BoardReplica } from "./project-board-store";
import {
  askSchema,
  DONE_HIDDEN_AFTER_MS,
  LINK_KINDS,
  linkSchema,
  MAX_DETAIL_BYTES,
  newCardId,
  parseCard,
  statusSince,
  STATUS_KINDS,
  ASK_KINDS,
  type BoardCard,
  type BoardChange,
  type BoardConfig,
  type CardLink,
  type RecordValue,
} from "./project-board-records";
import { bounded, requireCard, writeMessage } from "./project-board-tool";

/**
 * Project boards for an AI connector client, such as Claude keeping a board
 * in step with Slack and email. It works on the same local board copies the
 * ProjectBoard tool uses. A client sees every board's name, but reads or
 * changes only boards the user allowed it: the first use of a board raises
 * an approval card, and the answer is kept on the client's grant. Deleting
 * a card asks every time.
 */

/** What the board tools need from the connector for one call. */
export interface ConnectorBoardContext {
  /** Names the client in card history and on cards. */
  clientName: string;
  /** Project IDs this client may use. */
  allowed(): readonly string[];
  allow(projectId: string): void;
  /** Raises an approval card and resolves when the user allows it. Throws when denied. */
  approve(action: string, summary: string): Promise<void>;
}

const linkInput = z.object({
  kind: z.enum(LINK_KINDS).default("url").describe("thread for a Slack thread or DM, url for an email or web page, ticket for a ticket"),
  ref: z.string().min(1).max(2000).describe("The permalink or URL"),
  label: z.string().max(200).optional().describe("Short label, such as \"Slack #wakespeed\" or the email subject"),
});

const boardArg = z.string().min(1).describe("Board name or project ID from list_boards");
const cardIdArg = z.string().min(1).describe("Card ID from list_cards");

export const CONNECTOR_BOARD_INPUTS = {
  list_cards: {
    board: boardArg,
    status: z.string().optional().describe("Only cards in this status key"),
    kind: z.enum(STATUS_KINDS).optional().describe("Only cards in statuses of this kind"),
    link_ref: z.string().optional().describe("Only cards with a link to this permalink or URL, done cards included. Use it to skip messages that already have a card."),
    query: z.string().optional().describe("Only cards whose title, notes, detail or links contain this text"),
    include_old_done: z.boolean().optional().describe("Include cards done for more than 30 days"),
  },
  get_card: { board: boardArg, card_id: cardIdArg },
  add_card: {
    board: boardArg,
    title: z.string().min(1).max(300),
    detail: z.string().optional().describe("Markdown: the message text, who sent it and when. Up to 48 KiB."),
    notes: z.string().max(2000).optional().describe("One short line: where it stands now"),
    source_link: linkInput.describe("Required: the message the card came from. A card that already links it is returned instead of a new one."),
  },
  update_card: {
    board: boardArg,
    card_id: cardIdArg,
    notes: z.string().max(2000).optional().describe("Replaces the card's short notes line"),
    append: z.string().optional().describe("Markdown added to the end of the card's detail, such as a follow-up message"),
    add_link: linkInput.optional().describe("A link to add, such as a reply thread. Skipped when the card has it already."),
  },
  move_card: {
    board: boardArg,
    card_id: cardIdArg,
    status: z.string().min(1).describe("Status key from list_cards"),
    why: z.string().min(1).describe("One line: why the card moves"),
    ask: z.object({ kind: z.enum(ASK_KINDS), text: z.string().min(1) }).optional()
      .describe("Required for a status of kind user: the exact question for the user"),
  },
  close_card: {
    board: boardArg,
    card_id: cardIdArg,
    why: z.string().optional().describe("One line: why it is done"),
  },
  delete_card: { board: boardArg, card_id: cardIdArg },
};

type Input<K extends keyof typeof CONNECTOR_BOARD_INPUTS> = z.infer<z.ZodObject<typeof CONNECTOR_BOARD_INPUTS[K]>>;

interface OpenBoard {
  projectId: string;
  name: string;
  board: BoardReplica;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Permalinks compare without case, surrounding space or a trailing slash. */
function sameRef(a: string, b: string): boolean {
  const normal = (ref: string) => ref.trim().replace(/\/+$/, "").toLowerCase();
  return normal(a) === normal(b);
}

function cardOut(card: BoardCard, config: BoardConfig) {
  const status = config.statuses.find((candidate) => candidate.key === card.status);
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    statusName: status?.name ?? card.status,
    kind: status?.kind ?? "unknown",
    notes: card.notes,
    links: card.links,
    updatedAt: iso(card.updatedAt),
  };
}

function checkDetailSize(detail: string): void {
  if (Buffer.byteLength(detail, "utf8") > MAX_DETAIL_BYTES) {
    throw new Error(`detail is over 48 KiB (${MAX_DETAIL_BYTES} bytes). Keep the message and link the rest.`);
  }
}

function link(input: z.infer<typeof linkInput>): CardLink {
  return linkSchema.parse({ kind: input.kind, ref: input.ref.trim(), label: input.label ?? "" });
}

/** The board named [wanted], after the user allowed this client to use it. */
async function openBoard(ctx: ConnectorBoardContext, wanted: string): Promise<OpenBoard> {
  const store = projectBoards();
  if (!store.relayBase) throw new Error("Boards are unavailable: this computer has no relay configured.");
  const boards = store.boards();
  const match = boards.find((candidate) => candidate.projectId === wanted.trim())
    ?? boards.find((candidate) => candidate.name.trim().toLowerCase() === wanted.trim().toLowerCase());
  if (!match) throw new Error(`No board "${wanted}" on this computer. list_boards shows the boards.`);
  if (!ctx.allowed().includes(match.projectId)) {
    await ctx.approve("board_access",
      `Let ${ctx.clientName} use the ${match.name} board: read cards, add cards, add notes and links, and move or close cards. `
      + `Deleting a card still asks each time. This lasts until you remove ${ctx.clientName} under Devices.`);
    ctx.allow(match.projectId);
  }
  const board = store.board(match.projectId);
  if (!board) throw new Error(`The ${match.name} board is no longer available on this computer.`);
  await bounded(board.sync());
  return { ...match, board };
}

async function save(open: OpenBoard, change: BoardChange) {
  const outcome = await open.board.write(change);
  if (!outcome.ok) throw new Error(`Not saved: ${outcome.error}`);
  const card = parseCard(outcome.value);
  return { message: writeMessage(outcome), ...(card ? { card: cardOut(card, open.board.config()) } : {}) };
}

/** Every board on this computer, and whether this client may use it yet. */
export function listBoards(ctx: ConnectorBoardContext) {
  const allowed = new Set(ctx.allowed());
  return {
    boards: projectBoards().boards().map((board) => ({
      id: board.projectId,
      name: board.name,
      allowed: allowed.has(board.projectId),
    })),
    note: "Using a board that is not allowed yet asks the user once on their phone.",
  };
}

export async function listCards(ctx: ConnectorBoardContext, args: Input<"list_cards">) {
  const open = await openBoard(ctx, args.board);
  const view = open.board.view();
  const config = open.board.config(view);
  const query = args.query?.trim().toLowerCase();
  const now = Date.now();
  let hidden = 0;
  const cards = open.board.cards(view).filter((card) => {
    const status = config.statuses.find((candidate) => candidate.key === card.status);
    if (args.status && card.status !== args.status) return false;
    if (args.kind && status?.kind !== args.kind) return false;
    if (args.link_ref && !card.links.some((entry) => sameRef(entry.ref, args.link_ref ?? ""))) return false;
    if (query) {
      const texts = [card.title, card.notes, card.detail, ...card.links.flatMap((entry) => [entry.ref, entry.label])];
      if (!texts.some((text) => text.toLowerCase().includes(query))) return false;
    }
    // A link search finds old cards too, so a message is never carded twice.
    if (!args.link_ref && !args.include_old_done && status?.kind === "done" && now - statusSince(card) > DONE_HIDDEN_AFTER_MS) {
      hidden++;
      return false;
    }
    return true;
  }).sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    board: open.name,
    statuses: config.statuses.map((status) => ({ key: status.key, name: status.name, kind: status.kind })),
    cards: cards.map((card) => cardOut(card, config)),
    ...(hidden ? { hiddenOldDone: hidden } : {}),
  };
}

export async function getCard(ctx: ConnectorBoardContext, args: Input<"get_card">) {
  const open = await openBoard(ctx, args.board);
  const card = requireCard(open.board, args.card_id);
  return {
    ...cardOut(card, open.board.config()),
    detail: card.detail,
    ...(card.waitingOn ? { waitingOn: card.waitingOn } : {}),
    ...(card.ask ? { ask: { kind: card.ask.kind, text: card.ask.text } } : {}),
    // A saved answer stays private until the user sends it.
    ...(card.reply?.sentAt !== undefined ? {
      reply: {
        ...(card.reply.approved !== undefined ? { approved: card.reply.approved } : {}),
        ...(card.reply.text ? { text: card.reply.text } : {}),
        sentAt: iso(card.reply.sentAt),
      },
    } : {}),
    history: card.history.map((move) => ({ ...move, at: iso(move.at) })),
    createdAt: iso(card.createdAt),
  };
}

export async function addCard(ctx: ConnectorBoardContext, args: Input<"add_card">) {
  const open = await openBoard(ctx, args.board);
  const source = link(args.source_link);
  const existing = open.board.cards().find((card) => card.links.some((entry) => sameRef(entry.ref, source.ref)));
  const config = open.board.config();
  if (existing) {
    return { created: false, message: `Card ${existing.id} already tracks this link.`, card: cardOut(existing, config) };
  }
  const detail = args.detail ?? "";
  checkDetailSize(detail);
  const status = config.statuses.find((candidate) => candidate.kind === "new")?.key ?? config.statuses[0].key;
  const now = Date.now();
  const card: RecordValue = {
    v: 1,
    id: newCardId(),
    title: args.title.trim(),
    status,
    notes: args.notes ?? "",
    ...(detail ? { detail } : {}),
    links: [source],
    history: [{ at: now, by: ctx.clientName, to: status, why: `Added from ${source.label || source.ref}` }],
    createdAt: now,
    updatedAt: now,
  };
  return { created: true, ...await save(open, { kind: "create", card }) };
}

export async function updateCard(ctx: ConnectorBoardContext, args: Input<"update_card">) {
  if (args.notes === undefined && !args.append && !args.add_link) {
    throw new Error("update_card needs notes, append or add_link.");
  }
  const open = await openBoard(ctx, args.board);
  const card = requireCard(open.board, args.card_id);
  const changes: { notes?: string; detail?: string; links?: CardLink[] } = {};
  if (args.notes !== undefined) changes.notes = args.notes;
  if (args.append) {
    const detail = card.detail.trim() ? `${card.detail.trimEnd()}\n\n---\n\n${args.append}` : args.append;
    checkDetailSize(detail);
    changes.detail = detail;
  }
  if (args.add_link) {
    const added = link(args.add_link);
    if (!card.links.some((entry) => sameRef(entry.ref, added.ref))) {
      if (card.links.length >= 20) throw new Error("The card has 20 links, the most it can hold.");
      changes.links = [...card.links, added];
    }
  }
  if (Object.keys(changes).length === 0) {
    return { message: "The card already has that link. Nothing changed.", card: cardOut(card, open.board.config()) };
  }
  return save(open, { kind: "update", cardId: card.id, changes, at: Date.now() });
}

export async function moveCard(ctx: ConnectorBoardContext, args: Input<"move_card">) {
  const open = await openBoard(ctx, args.board);
  const card = requireCard(open.board, args.card_id);
  // Asks from the connector name no chat: the answer shows on the card, read with get_card.
  const ask = args.ask ? askSchema.parse({ kind: args.ask.kind, text: args.ask.text }) : undefined;
  return save(open, {
    kind: "move", cardId: card.id, from: card.status, to: args.status, why: args.why.trim(),
    ...(ask ? { ask } : {}), by: ctx.clientName, at: Date.now(),
  });
}

export async function closeCard(ctx: ConnectorBoardContext, args: Input<"close_card">) {
  const open = await openBoard(ctx, args.board);
  const card = requireCard(open.board, args.card_id);
  const done = open.board.config().statuses.find((status) => status.kind === "done");
  if (!done) throw new Error(`The ${open.name} board has no done status.`);
  return save(open, {
    kind: "move", cardId: card.id, from: card.status, to: done.key, why: args.why?.trim() || "Closed",
    by: ctx.clientName, at: Date.now(),
  });
}

export async function deleteCard(ctx: ConnectorBoardContext, args: Input<"delete_card">) {
  const open = await openBoard(ctx, args.board);
  const card = requireCard(open.board, args.card_id);
  await ctx.approve("board_delete", `Delete card ${card.id} "${card.title}" from the ${open.name} board. It can't be brought back.`);
  const outcome = await open.board.write({ kind: "delete", cardId: card.id, at: Date.now() });
  if (!outcome.ok) throw new Error(`Not deleted: ${outcome.error}`);
  return { message: `Deleted card ${card.id}. ${writeMessage(outcome)}` };
}
