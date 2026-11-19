import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { isRecord, unknownArray } from "./value-guards";

/*
 * The plaintext inside each sealed board record (docs/project-boards.md,
 * "Plaintext"), and the changes agents make to it. Parsing is lenient the way
 * the app's is: a field of the wrong shape reads as absent, and fields this
 * server does not know survive a rewrite.
 */

export const STATUS_KINDS = ["new", "active", "user", "other", "done"] as const;
export type StatusKind = typeof STATUS_KINDS[number];
export const ASK_KINDS = ["approve", "send", "decide", "answer"] as const;
export const WAITING_KINDS = ["user", "person", "agent"] as const;
export const LINK_KINDS = ["session", "ticket", "thread", "url"] as const;

export const MAX_DETAIL_BYTES = 48 * 1024;
export const MAX_SEALED_BYTES = 64 * 1024;
export const MAX_HISTORY = 50;
/** Intake item IDs a card remembers, so an item applied twice changes it once. */
export const MAX_INTAKE_IDS = 50;
export const MAX_TITLE_CHARS = 200;
export const DONE_HIDDEN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export const CONFIG_RECORD = "config";
export const cardRecordId = (cardId: string): string => `card.${cardId}`;
export const proposalRecordId = (proposalId: string): string => `proposal.${proposalId}`;
export const RECORD_ID_PATTERN = /^(config|card\.[A-Za-z0-9_-]{1,64}|proposal\.[A-Za-z0-9_-]{1,64}|intake\.[A-Za-z0-9_-]{1,64})$/;
const INTAKE_PREFIX = "intake.";
/** An item a service posted, at version 1, or the claim a computer wrote over it. */
export const isIntakeRecordId = (recordId: string): boolean => recordId.startsWith(INTAKE_PREFIX);
export const intakeItemId = (recordId: string): string => recordId.slice(INTAKE_PREFIX.length);
const CARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const statusSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().min(1).max(80),
  kind: z.enum(STATUS_KINDS),
  meaning: z.string().max(1000).default(""),
});
export type BoardStatus = z.output<typeof statusSchema>;
export const askSchema = z.object({
  kind: z.enum(ASK_KINDS),
  text: z.string().min(1).max(4000),
  sessionId: z.string().optional(),
});
export type CardAsk = z.output<typeof askSchema>;
export const waitingOnSchema = z.object({ kind: z.enum(WAITING_KINDS), name: z.string().min(1).max(200) });
export type CardWaitingOn = z.output<typeof waitingOnSchema>;
export const linkSchema = z.object({
  kind: z.enum(LINK_KINDS),
  ref: z.string().min(1).max(2000),
  label: z.string().max(200).default(""),
});
export type CardLink = z.output<typeof linkSchema>;
const moveSchema = z.object({
  at: z.number(),
  by: z.string().default(""),
  from: z.string().optional(),
  to: z.string(),
  why: z.string().default(""),
});
export type CardMove = z.output<typeof moveSchema>;

export const DEFAULT_STATUSES: BoardStatus[] = [
  { key: "inbox", name: "Inbox", kind: "new", meaning: "Came in from a ticket or message. Nobody has looked yet." },
  { key: "doing", name: "Doing", kind: "active", meaning: "An agent is working on it now." },
  { key: "needs_you", name: "Needs you", kind: "user", meaning: "Waiting on a decision, an approval or an answer from you." },
  { key: "waiting", name: "Waiting", kind: "other", meaning: "Asked someone else and waiting for their answer." },
  { key: "done", name: "Done", kind: "done", meaning: "Finished or dropped." },
];

export interface BoardConfig {
  statuses: BoardStatus[];
  rules: string;
}

export interface BoardCard {
  id: string;
  title: string;
  status: string;
  notes: string;
  detail: string;
  waitingOn?: CardWaitingOn;
  ask?: CardAsk;
  links: CardLink[];
  history: CardMove[];
  createdAt: number;
  updatedAt: number;
  /** IDs of the last intake items applied to this card. */
  intake: string[];
  /** The record as read, so a rewrite keeps fields this server does not know. */
  raw: Record<string, unknown>;
}

/** A record's plaintext as JSON. Tombstones and configs are plain objects too. */
export type RecordValue = Record<string, unknown>;

function parsed<T extends z.ZodType>(schema: T, value: unknown): z.output<T> | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

function list<T extends z.ZodType>(schema: T, value: unknown): z.output<T>[] {
  const items: z.output<T>[] = [];
  for (const item of unknownArray(value)) {
    const value = parsed(schema, item);
    if (value !== undefined) items.push(value);
  }
  return items;
}

const text = (value: unknown): string => typeof value === "string" ? value : "";

/** The board's config, or the five defaults when the record is missing or has no statuses. */
export function parseConfig(value: RecordValue | undefined): BoardConfig {
  const statuses = value
    ? unknownArray(value.statuses).flatMap((item) => {
      if (!isRecord(item) || typeof item.key !== "string" || typeof item.name !== "string") return [];
      // An unknown kind reads as "new", the same as the app.
      const kind = STATUS_KINDS.find((candidate) => candidate === item.kind) ?? "new";
      return [{ key: item.key, name: item.name, kind, meaning: text(item.meaning) }];
    })
    : [];
  return { statuses: statuses.length ? statuses : DEFAULT_STATUSES, rules: text(value?.rules) };
}

export function isTombstone(value: RecordValue | undefined): boolean {
  return value?.deleted === true;
}

/** A card record, or null for a tombstone or a record missing required fields. */
export function parseCard(value: RecordValue | undefined): BoardCard | null {
  if (!value || isTombstone(value)) return null;
  const { id, title, status, createdAt } = value;
  if (typeof id !== "string" || typeof title !== "string" || typeof status !== "string" || typeof createdAt !== "number") {
    return null;
  }
  return {
    id,
    title,
    status,
    notes: text(value.notes),
    detail: text(value.detail),
    waitingOn: parsed(waitingOnSchema, value.waitingOn),
    ask: parsed(askSchema, value.ask),
    links: list(linkSchema, value.links),
    history: list(moveSchema, value.history),
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
    intake: unknownArray(value.intake).filter((id): id is string => typeof id === "string"),
    raw: value,
  };
}

const KNOWN_CARD_FIELDS = new Set([
  "v", "id", "title", "status", "notes", "detail", "waitingOn", "ask", "links", "history", "createdAt", "updatedAt", "intake",
]);

/** The record for [card], keeping unknown fields from the record it was read from. */
export function serializeCard(card: BoardCard): RecordValue {
  const extra = Object.fromEntries(Object.entries(card.raw).filter(([key]) => !KNOWN_CARD_FIELDS.has(key)));
  return {
    ...extra,
    v: 1,
    id: card.id,
    title: card.title,
    status: card.status,
    notes: card.notes,
    ...(card.detail ? { detail: card.detail } : {}),
    ...(card.waitingOn ? { waitingOn: card.waitingOn } : {}),
    ...(card.ask ? { ask: card.ask } : {}),
    links: card.links,
    history: card.history.slice(-MAX_HISTORY),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    ...(card.intake.length ? { intake: card.intake.slice(-MAX_INTAKE_IDS) } : {}),
  };
}

export function newCardId(): string {
  return `c_${randomBytes(6).toString("hex")}`;
}

export function newProposalId(): string {
  return `r_${randomBytes(6).toString("hex")}`;
}

export function isCardId(value: string): boolean {
  return CARD_ID_PATTERN.test(value);
}

/** The time the card reached its current status. */
export function statusSince(card: BoardCard): number {
  for (let i = card.history.length - 1; i >= 0; i--) {
    if (card.history[i].to === card.status) return card.history[i].at;
  }
  return card.createdAt;
}

/** Fields an update may set. Absent means unchanged; null clears. */
export interface CardFieldChanges {
  title?: string;
  notes?: string | null;
  detail?: string | null;
  waitingOn?: CardWaitingOn | null;
  ask?: CardAsk | null;
  links?: CardLink[] | null;
}

/**
 * One change an agent made, kept in the outbox until the relay accepts it.
 * Changes are stored as intent, not as the resulting record, so a change
 * that loses a race can be applied again to whatever the record became.
 */
export type BoardChange =
  | { kind: "create"; card: RecordValue }
  | { kind: "update"; cardId: string; changes: CardFieldChanges; at: number }
  | {
    kind: "move";
    cardId: string;
    from: string;
    to: string;
    why: string;
    ask?: CardAsk;
    by: string;
    at: number;
  }
  | { kind: "delete"; cardId: string; at: number }
  | { kind: "propose"; proposal: RecordValue }
  | { kind: "intake"; cardId: string; itemId: string; item: IntakeItem; at: number };

export function changeRecordId(change: BoardChange): string {
  switch (change.kind) {
    case "create": return cardRecordId(text(change.card.id));
    case "propose": return proposalRecordId(text(change.proposal.id));
    default: return cardRecordId(change.cardId);
  }
}

export type ChangeResult = { ok: true; value: RecordValue } | { ok: false; error: string };

function statusLabel(config: BoardConfig, key: string): string {
  const status = config.statuses.find((candidate) => candidate.key === key);
  return status ? `${status.name} (${key})` : key;
}

/** Checks the rules the server enforces on every card it writes. */
export function checkCard(card: BoardCard, config: BoardConfig): string | null {
  const status = config.statuses.find((candidate) => candidate.key === card.status);
  if (!status) {
    return `Unknown status "${card.status}". Use one of: ${config.statuses.map((s) => s.key).join(", ")}.`;
  }
  if (status.kind === "user" && !card.ask) {
    return `${status.name} waits on the user, so the card needs an ask: the exact question, with kind approve, send, decide or answer.`;
  }
  if (!card.title.trim()) return "A card needs a title.";
  if (card.title.length > MAX_TITLE_CHARS) return `Keep the title under ${MAX_TITLE_CHARS} characters; put the rest in notes or detail.`;
  if (Buffer.byteLength(card.detail, "utf8") > MAX_DETAIL_BYTES) {
    return `detail is ${Buffer.byteLength(card.detail, "utf8")} bytes; the limit is ${MAX_DETAIL_BYTES} (48 KiB).`;
  }
  return null;
}

/**
 * Applies [change] to [base], the record as the relay last had it (undefined
 * when it has none). Returns the new record or why the change no longer fits.
 */
export function applyChange(base: RecordValue | undefined, change: BoardChange, config: BoardConfig): ChangeResult {
  if (change.kind === "create") {
    if (base) return { ok: false, error: "A card with this ID already exists." };
    const card = parseCard(change.card);
    if (!card) return { ok: false, error: "The new card is malformed." };
    const problem = checkCard(card, config);
    return problem ? { ok: false, error: problem } : { ok: true, value: serializeCard(card) };
  }
  if (change.kind === "intake") return applyIntake(base, change, config);
  if (change.kind === "propose") {
    return base ? { ok: false, error: "A proposal with this ID already exists." } : { ok: true, value: change.proposal };
  }
  if (change.kind === "delete") {
    if (isTombstone(base)) return { ok: true, value: base ?? {} };
    return { ok: true, value: { v: 1, id: change.cardId, deleted: true, updatedAt: change.at } };
  }
  const card = parseCard(base);
  if (!card) {
    return { ok: false, error: isTombstone(base) ? `Card ${change.cardId} was deleted.` : `No card ${change.cardId} on this board.` };
  }
  let next: BoardCard;
  if (change.kind === "update") {
    const { changes } = change;
    next = {
      ...card,
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.notes !== undefined ? { notes: changes.notes ?? "" } : {}),
      ...(changes.detail !== undefined ? { detail: changes.detail ?? "" } : {}),
      ...(changes.links !== undefined ? { links: changes.links ?? [] } : {}),
      waitingOn: changes.waitingOn === undefined ? card.waitingOn : changes.waitingOn ?? undefined,
      ask: changes.ask === undefined ? card.ask : changes.ask ?? undefined,
      updatedAt: change.at,
    };
  } else {
    if (card.status !== change.from && card.status !== change.to) {
      const last = card.history.at(-1);
      const who = last?.by ? ` by ${last.by}` : "";
      const when = last ? ` at ${new Date(last.at).toISOString()}` : "";
      return {
        ok: false,
        error: `Card "${card.title}" was moved from ${statusLabel(config, change.from)} to ${statusLabel(config, card.status)}${who}${when}. `
          + `Your move to ${statusLabel(config, change.to)} was not applied. Read the card again and decide whether it still should move.`,
      };
    }
    const moved = card.status !== change.to;
    const target = config.statuses.find((status) => status.key === change.to);
    next = {
      ...card,
      status: change.to,
      // An ask belongs to a status that waits on the user. Leaving one answers it.
      ask: change.ask ?? (target?.kind === "user" ? card.ask : undefined),
      history: moved
        ? [...card.history, { at: change.at, by: change.by, from: card.status, to: change.to, why: change.why }].slice(-MAX_HISTORY)
        : card.history,
      updatedAt: change.at,
    };
  }
  const problem = checkCard(next, config);
  return problem ? { ok: false, error: problem } : { ok: true, value: serializeCard(next) };
}

/** Validates a proposed config: unique keys and at least one status. */
export function checkProposedStatuses(statuses: BoardStatus[]): string | null {
  if (statuses.length === 0) return "A board needs at least one status.";
  if (statuses.length > 30) return "A board can have at most 30 statuses.";
  const keys = new Set<string>();
  for (const status of statuses) {
    if (keys.has(status.key)) return `Status key "${status.key}" appears twice.`;
    keys.add(status.key);
  }
  return null;
}

export const INTAKE_EVENTS = ["opened", "updated", "closed", "reopened"] as const;

/** The plaintext a service seals into an intake box ("Item plaintext"). Unknown fields are dropped. */
export const intakeItemSchema = z.object({
  v: z.literal(1),
  source: z.string().max(200).refine((value) => value.trim().length > 0, "source is empty"),
  ref: z.string().max(2000).refine((value) => value.trim().length > 0, "ref is empty"),
  event: z.enum(INTAKE_EVENTS),
  title: z.string().optional(),
  detail: z.string().optional(),
  note: z.string().optional(),
  url: z.string().optional(),
  at: z.number().optional(),
}).refine((item) => item.event !== "opened" || !!item.title?.trim(), { message: "an opened item needs a title", path: ["title"] });
export type IntakeItem = z.output<typeof intakeItemSchema>;

/** Parses an opened intake box. The error says what was wrong, for the claim record. */
export function parseIntakeItem(plaintext: string): { ok: true; item: IntakeItem } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return { ok: false, error: "The item is not JSON." };
  }
  const result = intakeItemSchema.safeParse(value);
  if (result.success) return { ok: true, item: result.data };
  const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "item"}: ${issue.message}`);
  return { ok: false, error: `The item is invalid: ${issues.join("; ")}` };
}

/** The card every event for one service item lands on: h_ and 24 hex characters of SHA-256(source + "\n" + ref). */
export function intakeCardId(source: string, ref: string): string {
  return `h_${createHash("sha256").update(`${source}\n${ref}`, "utf8").digest("hex").slice(0, 24)}`;
}

/** [value] when it is an http or https URL, so a service can't hand the app another kind of link. */
function webUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Cuts [value] to at most [bytes] of UTF-8 without splitting a character. */
function clipBytes(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  return Buffer.from(value, "utf8").subarray(0, bytes).toString("utf8").replace(/\uFFFD+$/, "");
}

/**
 * Fits a service's text into the card limits. A service can send more than an
 * agent may write, and dropping the whole item would lose the ticket.
 */
function intakeText(item: IntakeItem) {
  const title = item.title?.trim();
  const url = webUrl(item.url);
  const truncated = `\n\n(Cut to fit the card. The full text is ${url ? `at ${url}` : `in ${item.source}`}.)`;
  return {
    title: title ? title.slice(0, MAX_TITLE_CHARS) : undefined,
    detail: item.detail === undefined || Buffer.byteLength(item.detail, "utf8") <= MAX_DETAIL_BYTES
      ? item.detail
      : clipBytes(item.detail, MAX_DETAIL_BYTES - Buffer.byteLength(truncated, "utf8")) + truncated,
    note: item.note?.trim(),
    url,
  };
}

/**
 * Applies one intake item to its card ("Turning items into cards"). Every
 * event first creates the card when it is missing, then sets the fields the
 * item carries, then moves it for closed and reopened. An item the card
 * already lists, or a card the user deleted, leaves the record as it is.
 */
function applyIntake(
  base: RecordValue | undefined,
  change: Extract<BoardChange, { kind: "intake" }>,
  config: BoardConfig,
): ChangeResult {
  if (isTombstone(base)) return { ok: true, value: base ?? {} };
  const existing = parseCard(base);
  if (base && !existing) return { ok: false, error: `Card ${change.cardId} is malformed, so the item was not applied.` };
  if (existing?.intake.includes(change.itemId)) return { ok: true, value: base ?? {} };
  const { item, at } = change;
  const by = item.source;
  const fields = intakeText(item);
  const firstNew = config.statuses.find((status) => status.kind === "new") ?? config.statuses[0];
  const label = `${item.source} ${item.ref}`.slice(0, 200);
  let card: BoardCard = existing ?? {
    id: change.cardId,
    title: fields.title ?? label,
    status: firstNew.key,
    notes: "",
    detail: "",
    links: [{ kind: "ticket", ref: (fields.url ?? item.ref).slice(0, 2000), label }],
    history: [{ at, by, to: firstNew.key, why: fields.note ?? "" }],
    createdAt: at,
    updatedAt: at,
    intake: [],
    raw: {},
  };
  card = {
    ...card,
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
    ...(fields.note !== undefined ? { notes: fields.note } : {}),
    intake: [...card.intake, change.itemId].slice(-MAX_INTAKE_IDS),
    updatedAt: at,
  };
  const current = config.statuses.find((status) => status.key === card.status);
  const target = item.event === "closed" && current?.kind !== "done"
    ? config.statuses.find((status) => status.kind === "done")
    : item.event === "reopened" && current?.kind === "done" ? firstNew : undefined;
  if (target && target.key !== card.status) {
    card = {
      ...card,
      status: target.key,
      ask: target.kind === "user" ? card.ask : undefined,
      history: [...card.history, { at, by, from: card.status, to: target.key, why: fields.note ?? "" }].slice(-MAX_HISTORY),
    };
  }
  const problem = checkCard(card, config);
  return problem ? { ok: false, error: problem } : { ok: true, value: serializeCard(card) };
}
