import { createHash } from "crypto";
import { z } from "zod";
import type { McpTextResult } from "./app-tool-handlers";
import { attachBoardImages } from "./board-images";
import { projectBoards, type BoardReplica, type BoardWriteOutcome } from "./project-board-store";
import {
  ASK_KINDS,
  askSchema,
  cardRecordId,
  checkProposedStatuses,
  DONE_HIDDEN_AFTER_MS,
  isTombstone,
  LINK_KINDS,
  linkSchema,
  MAX_DETAIL_BYTES,
  newCardId,
  newProposalId,
  parseCard,
  statusSchema,
  statusSince,
  STATUS_KINDS,
  ticketCard,
  WAITING_KINDS,
  waitingOnSchema,
  type BoardCard,
  type BoardConfig,
  type CardFieldChanges,
  type RecordValue,
} from "./project-board-records";
import { getSession } from "./session-store";
import { errorMessage } from "./value-guards";

export const PROJECT_BOARD_TOOL_DESCRIPTION =
  "The shared board of this chat's project: one list of work items (cards) that every chat in the project and the user's app see. "
  + "Track work that outlives this turn here; your step list inside one turn stays in your native todo tool. "
  + "list returns card summaries without detail; get returns one card in full with detail and history. "
  + "create and update set title, notes (short: where it stands now), detail, links, waiting_on and ask. In update a field left out is unchanged and null clears it. "
  + "detail is Markdown, up to 48 KiB, and holds the full source material the user needs to decide from the card without opening this chat: "
  + "the ticket's full request text, the full drafted reply, the full proposed release notes. Paste the full text, not a summary or a pointer to the chat. "
  + "detail can show screenshots from this computer, such as before and after shots of a UI change: a Markdown image ![Before](/absolute/path.png) or a socketagent-compare block. "
  + "The image is saved on this computer and the card holds only a link, so the app loads it from here. "
  + "move changes a card's status with a one-line why. A card in a status of kind user needs an ask with the exact question; give it in the same call or set it first. "
  + "A ticket link's ref is the ticket's web URL, so the app can open it; one ticket gets one card, and create refuses a second. "
  + "delete is for cards made by mistake; finished work moves to a done status. "
  + "The user answers asks in the app and sends the answers as one message to the chat that asked, starting \"Answers from the <board> board:\" and listing each card's ID, question and answer (Approved, Declined, Send it, Don't send, or the answer text). "
  + "That message is the user's answer in their words; act on each answer and move its card on. A card's reply field shows an answer that was sent. "
  + "propose_rules submits a full new set of statuses and rules with a why; the user approves or declines it in the app. "
  + "Status keys, kinds and the user's rules arrive in a <socketagent_project_board> block.";

const askInput = z.object({
  kind: z.enum(ASK_KINDS).describe("approve, send, decide or answer"),
  text: z.string().describe("The exact question for the user"),
});

export const PROJECT_BOARD_TOOL_INPUT = {
  action: z.enum(["list", "get", "create", "update", "move", "delete", "propose_rules"]),
  card_id: z.string().optional().describe("Card ID for get, update, move and delete"),
  title: z.string().optional().describe("Short card title. Required for create"),
  status: z.string().optional().describe("Status key: the new card's status for create (default: the first status of kind new), the target for move, or a filter for list"),
  notes: z.string().nullable().optional().describe("Short: where this stands now"),
  detail: z.string().nullable().optional().describe("Markdown up to 48 KiB with the full material the user needs to decide: the ticket's full request text, the full drafted reply, the full proposed release notes"),
  waiting_on: z.object({
    kind: z.enum(WAITING_KINDS),
    name: z.string().describe("Who: a person's name, an agent, or You for the user"),
  }).nullable().optional(),
  ask: askInput.nullable().optional().describe("What the card asks of the user. Required for a card in a status of kind user"),
  links: z.array(z.object({
    kind: z.enum(LINK_KINDS),
    ref: z.string().describe("A session ID, ticket key, thread ID or URL"),
    label: z.string().optional(),
  })).max(20).nullable().optional().describe("Replaces the card's links"),
  why: z.string().optional().describe("One line: why the card moves (move), was created (create), or why the rules should change (propose_rules)"),
  kind: z.enum(STATUS_KINDS).optional().describe("For list: only cards in statuses of this kind"),
  waiting_on_name: z.string().optional().describe("For list: only cards waiting on a name containing this text"),
  query: z.string().optional().describe("For list: only cards whose title, notes, ask or detail contain this text"),
  include_old_done: z.boolean().optional().describe("For list: include cards in a done status for more than 30 days"),
  statuses: z.array(z.object({
    key: z.string(),
    name: z.string(),
    kind: z.enum(STATUS_KINDS),
    meaning: z.string().optional(),
  })).optional().describe("For propose_rules: the full proposed list of statuses, in order"),
  rules: z.string().optional().describe("For propose_rules: the full proposed rules text"),
};

const projectBoardArgsSchema = z.object(PROJECT_BOARD_TOOL_INPUT);
export type ProjectBoardToolArgs = z.infer<typeof projectBoardArgsSchema>;

/** What the tool needs from the chat calling it. */
export interface ProjectBoardToolContext {
  getSessionId(): string;
  /** The project a new child agent joined before it had a session ID. */
  getProjectBoardHint?(): string | null;
}

const SYNC_WAIT_MS = 4_000;

/** Waits for [work] up to [ms]; the work carries on in the background after that. */
export async function bounded(work: Promise<unknown>, ms = SYNC_WAIT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  if (timer) clearTimeout(timer);
}

function textResult(value: unknown, isError = false): McpTextResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

function statusOf(config: BoardConfig, key: string) {
  return config.statuses.find((status) => status.key === key);
}

function cardSummary(card: BoardCard, config: BoardConfig) {
  const status = statusOf(config, card.status);
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    statusName: status?.name ?? card.status,
    kind: status?.kind ?? "unknown",
    notes: card.notes,
    ...(card.waitingOn ? { waitingOn: card.waitingOn } : {}),
    ...(card.ask ? { ask: card.ask } : {}),
    // A saved answer stays private until the user sends it.
    ...(card.reply?.sentAt !== undefined ? {
      reply: {
        ...(card.reply.approved !== undefined ? { approved: card.reply.approved } : {}),
        ...(card.reply.text ? { text: card.reply.text } : {}),
        sentAt: iso(card.reply.sentAt),
      },
    } : {}),
    ...(card.links.length ? { links: card.links } : {}),
    detailBytes: Buffer.byteLength(card.detail, "utf8"),
    inStatusSince: iso(statusSince(card)),
    updatedAt: iso(card.updatedAt),
  };
}

function cardInFull(card: BoardCard, config: BoardConfig) {
  const { detailBytes: _bytes, ...summary } = cardSummary(card, config);
  return {
    ...summary,
    detail: card.detail,
    history: card.history.map((move) => ({ ...move, at: iso(move.at) })),
    createdAt: iso(card.createdAt),
  };
}

export function writeMessage(outcome: Extract<BoardWriteOutcome, { ok: true }>): string {
  return outcome.pending
    ? "Saved on this computer. The relay could not be reached, so other chats and the app see it once it syncs."
    : "Saved to the board.";
}

/** The chat's title, which names it in card history. */
function chatName(sessionId: string): string {
  return getSession(sessionId)?.title?.trim() || sessionId || "An agent";
}

export function requireCard(board: BoardReplica, cardId: string | undefined): BoardCard {
  if (!cardId) throw new Error("card_id is required for this action.");
  const value = board.view().get(cardRecordId(cardId));
  if (isTombstone(value)) throw new Error(`Card ${cardId} was deleted.`);
  const card = parseCard(value);
  if (!card) throw new Error(`No card ${cardId} on this board. Use list to find card IDs.`);
  return card;
}

function parsedOr<T extends z.ZodType>(schema: T, value: unknown, field: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Invalid ${field}: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  return result.data;
}

/**
 * Turns tool input into card field changes, validating each one that is
 * present. Images in detail are saved on this computer and linked.
 */
async function fieldChanges(args: ProjectBoardToolArgs, sessionId: string): Promise<CardFieldChanges> {
  const changes: CardFieldChanges = {};
  if (args.title !== undefined) changes.title = args.title.trim();
  if (args.notes !== undefined) changes.notes = args.notes;
  if (args.detail !== undefined) {
    if (args.detail !== null && Buffer.byteLength(args.detail, "utf8") > MAX_DETAIL_BYTES) {
      throw new Error(`detail is over 48 KiB (${MAX_DETAIL_BYTES} bytes). Keep the material the user needs to decide and link the rest.`);
    }
    changes.detail = args.detail;
    if (args.detail) {
      const { detail, failed } = await attachBoardImages(args.detail, sessionId);
      if (failed > 0) {
        throw new Error(`${failed} image${failed === 1 ? "" : "s"} in detail could not be saved on this computer. `
          + "Use an absolute path to a PNG, JPEG, GIF or WebP file up to 20 MB that exists now.");
      }
      if (Buffer.byteLength(detail, "utf8") > MAX_DETAIL_BYTES) {
        throw new Error(`detail is over 48 KiB (${MAX_DETAIL_BYTES} bytes) with its image links. Keep the material the user needs to decide and link the rest.`);
      }
      changes.detail = detail;
    }
  }
  if (args.waiting_on !== undefined) {
    changes.waitingOn = args.waiting_on === null ? null : parsedOr(waitingOnSchema, args.waiting_on, "waiting_on");
  }
  if (args.ask !== undefined) {
    changes.ask = args.ask === null ? null : parsedOr(askSchema, { ...args.ask, sessionId }, "ask");
  }
  if (args.links !== undefined) {
    changes.links = args.links === null ? null : args.links.map((link) => parsedOr(linkSchema, link, "link"));
  }
  return changes;
}

async function write(board: BoardReplica, change: Parameters<BoardReplica["write"]>[0], config: () => BoardConfig) {
  const outcome = await board.write(change);
  if (!outcome.ok) return textResult(`Not saved: ${outcome.error}`, true);
  const card = parseCard(outcome.value);
  return textResult({
    message: writeMessage(outcome),
    ...(card ? { card: cardSummary(card, config()) } : {}),
  });
}

/** Runs one ProjectBoard action for the chat in [ctx]. */
export async function handleProjectBoardTool(ctx: ProjectBoardToolContext, args: ProjectBoardToolArgs): Promise<McpTextResult> {
  try {
    const store = projectBoards();
    const sessionId = ctx.getSessionId();
    const projectId = store.projectFor(sessionId, ctx.getProjectBoardHint?.() ?? null);
    if (!projectId) {
      return textResult("This chat is not in a project with a board on this computer. Track work with TaskBatch instead.", true);
    }
    if (!store.relayBase) {
      return textResult("Project boards are unavailable on this computer: boards are stored on the relay, and this server has no relay configured (RELAY_URL). Track work with TaskBatch until a relay is set up.", true);
    }
    const board = store.board(projectId);
    if (!board) return textResult("This chat's board is no longer granted to this computer.", true);
    const by = chatName(sessionId);
    const now = Date.now();
    const config = () => board.config();

    switch (args.action) {
      case "list": {
        await bounded(board.sync());
        const view = board.view();
        const current = board.config(view);
        const query = args.query?.trim().toLowerCase();
        const waitingOn = args.waiting_on_name?.trim().toLowerCase();
        let hidden = 0;
        const cards = board.cards(view).filter((card) => {
          const status = statusOf(current, card.status);
          if (args.status && card.status !== args.status) return false;
          if (args.kind && status?.kind !== args.kind) return false;
          if (waitingOn && !card.waitingOn?.name.toLowerCase().includes(waitingOn)) return false;
          if (query && ![card.title, card.notes, card.ask?.text ?? "", card.detail].some((text) => text.toLowerCase().includes(query))) {
            return false;
          }
          if (!args.include_old_done && status?.kind === "done" && now - statusSince(card) > DONE_HIDDEN_AFTER_MS) {
            hidden++;
            return false;
          }
          return true;
        }).sort((a, b) => b.updatedAt - a.updatedAt);
        const sync = board.state();
        return textResult({
          board: store.grant(projectId)?.name ?? projectId,
          ...(sync.online ? {} : { offline: `The relay could not be reached; this is this computer's copy${sync.pending ? ` with ${sync.pending} unsent change(s)` : ""}.` }),
          statuses: current.statuses.map((status) => ({ key: status.key, name: status.name, kind: status.kind })),
          cards: cards.map((card) => cardSummary(card, current)),
          ...(hidden ? { hiddenOldDone: hidden } : {}),
        });
      }
      case "get": {
        await bounded(board.sync());
        return textResult(cardInFull(requireCard(board, args.card_id), board.config()));
      }
      case "create": {
        const title = args.title?.trim();
        if (!title) return textResult("create needs a title.", true);
        await bounded(board.sync());
        const current = board.config();
        const status = args.status ?? current.statuses.find((candidate) => candidate.kind === "new")?.key ?? current.statuses[0].key;
        const changes = await fieldChanges(args, sessionId);
        const tickets = (changes.links ?? []).filter((link) => link.kind === "ticket").map((link) => link.ref);
        const tracking = ticketCard(board.cards(), tickets, current);
        if (tracking) {
          return textResult(`Card ${tracking.id} ("${tracking.title}") already tracks this ticket. Update or move it instead of making another.`, true);
        }
        const id = newCardId();
        const card: RecordValue = {
          v: 1,
          id,
          title,
          status,
          notes: changes.notes ?? "",
          ...(changes.detail ? { detail: changes.detail } : {}),
          ...(changes.waitingOn ? { waitingOn: changes.waitingOn } : {}),
          ...(changes.ask ? { ask: changes.ask } : {}),
          links: changes.links ?? [],
          history: [{ at: now, by, to: status, why: args.why?.trim() ?? "" }],
          createdAt: now,
          updatedAt: now,
        };
        return write(board, { kind: "create", card }, config);
      }
      case "update": {
        const changes = await fieldChanges(args, sessionId);
        if (changes.title === "") return textResult("A card needs a title; title cannot be empty.", true);
        if (Object.keys(changes).length === 0) {
          return textResult("update needs at least one of title, notes, detail, waiting_on, ask or links. Use move to change the status.", true);
        }
        await bounded(board.sync());
        const cardId = requireCard(board, args.card_id).id;
        return write(board, { kind: "update", cardId, changes, at: now }, config);
      }
      case "move": {
        if (!args.status) return textResult("move needs status, the key of the status to move to.", true);
        const why = args.why?.trim();
        if (!why) return textResult("move needs why: one line saying why the card moves.", true);
        await bounded(board.sync());
        const card = requireCard(board, args.card_id);
        const ask = args.ask ? parsedOr(askSchema, { ...args.ask, sessionId }, "ask") : undefined;
        return write(board, {
          kind: "move", cardId: card.id, from: card.status, to: args.status, why,
          ...(ask ? { ask } : {}), by, at: now,
        }, config);
      }
      case "delete": {
        await bounded(board.sync());
        const cardId = requireCard(board, args.card_id).id;
        const outcome = await board.write({ kind: "delete", cardId, at: now });
        return outcome.ok
          ? textResult({ message: `Deleted card ${cardId}. ${writeMessage(outcome)}` })
          : textResult(`Not deleted: ${outcome.error}`, true);
      }
      case "propose_rules": {
        const why = args.why?.trim();
        if (!why) return textResult("propose_rules needs why: what the change fixes.", true);
        if (!args.statuses || args.rules === undefined) {
          return textResult("propose_rules needs the full proposed statuses and the full rules text, including parts that stay the same.", true);
        }
        const statuses = args.statuses.map((status) => parsedOr(statusSchema, status, `status ${status.key}`));
        const problem = checkProposedStatuses(statuses);
        if (problem) return textResult(problem, true);
        const id = newProposalId();
        const proposal: RecordValue = {
          v: 1,
          id,
          by: sessionId,
          byName: by,
          why,
          config: { v: 1, statuses, rules: args.rules, updatedAt: now, updatedBy: by },
          state: "open",
          at: now,
        };
        const outcome = await board.write({ kind: "propose", proposal });
        return outcome.ok
          ? textResult({ message: `Proposal ${id} is open. The user approves or declines it in the app; the rules stay as they are until then. ${writeMessage(outcome)}` })
          : textResult(`Not proposed: ${outcome.error}`, true);
      }
    }
  } catch (error: unknown) {
    return textResult(`ProjectBoard error: ${errorMessage(error)}`, true);
  }
}

/** The <socketagent_project_board> block: statuses, their meanings, the rules and how to fill a card. */
export function buildBoardBlock(projectName: string, config: BoardConfig): string {
  const statuses = config.statuses
    .map((status) => `- ${status.key}: "${status.name}", kind ${status.kind}${status.meaning ? `. ${status.meaning}` : ""}`)
    .join("\n");
  return [
    "<socketagent_project_board>",
    `This chat is in the project "${projectName}", which has a shared board. These instructions replace any earlier board instructions in this conversation.`,
    "Track work that outlives this turn as cards with the ProjectBoard tool. TaskBatch is not available in this chat. Your step list inside one turn stays in your native todo tool.",
    "",
    "Statuses (key: name, kind, meaning):",
    statuses,
    "Kinds: new means nobody has looked yet; active means an agent is working on it; user means waiting on the user; other means waiting on someone else; done means finished or dropped.",
    "",
    "The user's rules for this board:",
    config.rules.trim() || "(The user has not written rules yet.)",
    "",
    "Keeping the board right:",
    "- Before making a card, list the board and update the card that already covers the work instead of making a second one.",
    "- When you start work in this project, check the cards that concern it, especially ones waiting on the user or on someone else.",
    "- Move a card as soon as its work moves: to an active status while you work on it, to a waiting status after you send something, to a done status when it is finished or dropped. Give a one-line why.",
    "- A card in a status of kind other names who it is waiting on in waiting_on.",
    "- The user answers asks in the app and sends them as one message to the chat that asked, starting \"Answers from the <board> board:\". It lists each card's ID, the question and the answer: Approved, Declined, Send it, Don't send, or the answer text, sometimes with a note. That message is the user's answer to those cards, in their words. Do what each answer approves, then move each card on.",
    "",
    "Filling a card:",
    "- notes is short: where the work stands now.",
    "- detail is Markdown, up to 48 KiB. A card waiting on the user carries everything needed to decide there: the ticket's full request text, the full drafted message, the full proposed text such as release notes. Paste the full text, not a summary, so the user can approve from the card without opening this chat.",
    "- Every card in a status of kind user has an ask: the exact question, with kind approve, send, decide or answer. Act on an answer only once its message reaches this chat.",
    "- Agents cannot change statuses or rules. Use propose_rules; the user approves or declines it in the app.",
    "</socketagent_project_board>",
  ].join("\n");
}

const BOARD_REMOVED_BLOCK = [
  "<socketagent_project_board>",
  "This chat is no longer in a project with a board. Ignore earlier board instructions; the ProjectBoard tool is gone. Track work with TaskBatch.",
  "</socketagent_project_board>",
].join("\n");

/** What a turn in a chat gets from its project's board. */
export interface BoardTurn {
  /** The board project the chat belongs to, or null. */
  projectId: string | null;
  /** The chat gets ProjectBoard in place of TaskBatch. */
  replacesTaskBatch: boolean;
  /** The block to deliver with this turn, or null when the chat already has the current one. */
  block: string | null;
  /** The digest to record once [block] reached the model. Null forgets the last one. */
  digest: string | null;
}

/**
 * Prepares a turn in [sessionId]: pulls its board (waiting a few seconds at
 * most) and decides whether the board block must be delivered again.
 * [lastDigest] is the session's own memory of the last delivery, used only
 * while a new chat has no session ID yet.
 */
export async function prepareBoardTurn(sessionId: string, hint: string | null, lastDigest: string | null): Promise<BoardTurn> {
  const store = projectBoards();
  const previous = sessionId ? store.deliveredDigest(sessionId) ?? null : lastDigest;
  try {
    return await boardTurnFor(sessionId, hint, previous);
  } catch (error: unknown) {
    // A board problem must never stop the chat's turn.
    console.warn(`[ProjectBoards] Could not prepare the board for ${sessionId || "a new chat"}: ${errorMessage(error)}`);
    return { projectId: null, replacesTaskBatch: false, block: null, digest: previous };
  }
}

async function boardTurnFor(sessionId: string, hint: string | null, previous: string | null): Promise<BoardTurn> {
  const store = projectBoards();
  const projectId = store.projectFor(sessionId, hint);
  if (!projectId) {
    return { projectId: null, replacesTaskBatch: false, block: previous ? BOARD_REMOVED_BLOCK : null, digest: null };
  }
  const board = store.board(projectId);
  if (!board) return { projectId, replacesTaskBatch: false, block: null, digest: previous };
  await bounded(board.sync());
  const block = buildBoardBlock(store.grant(projectId)?.name ?? projectId, board.config());
  const digest = createHash("sha256").update(block).digest("hex");
  return { projectId, replacesTaskBatch: true, block: digest === previous ? null : block, digest };
}

/** [prompt] with the turn's board block in front, when there is one to deliver. */
export function withBoardBlock(prompt: string, turn: BoardTurn | undefined): string {
  return turn?.block ? `${turn.block}\n\n${prompt}` : prompt;
}

/** Records that [sessionId] received the board block with [digest]. */
export function commitBoardTurn(sessionId: string, digest: string | null): void {
  if (sessionId) projectBoards().setDeliveredDigest(sessionId, digest);
}

/** The chat's history no longer holds the block (compaction or rewind), so deliver it again next turn. */
export function forgetBoardDelivery(sessionId: string): void {
  if (sessionId) projectBoards().setDeliveredDigest(sessionId, null);
}

export interface BoardToolset {
  projectBoard: boolean;
  taskBatch: boolean;
}

/** Which of ProjectBoard and TaskBatch a chat gets. Without a relay it gets both, and ProjectBoard explains why it cannot work. */
export function boardToolset(sessionId: string, hint: string | null): BoardToolset {
  const store = projectBoards();
  const inBoardProject = !!store.projectFor(sessionId, hint);
  return { projectBoard: inBoardProject, taskBatch: !inBoardProject || !store.relayBase };
}
