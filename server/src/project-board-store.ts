import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import {
  decodeBoardSecret,
  deriveBoardKeys,
  openBoardRecord,
  openIntakeBox,
  sealBoardRecord,
  sealedRecordBytes,
  type BoardKeys,
} from "./project-board-crypto";
import {
  BoardConflictError,
  BoardGoneError,
  BoardRejectedError,
  BoardUnavailableError,
  ProjectBoardRelay,
  relayHttpBase,
  type BoardFetch,
} from "./project-board-relay";
import {
  applyChange,
  cardRecordId,
  changeRecordId,
  CONFIG_RECORD,
  intakeCardId,
  intakeItemId,
  intakeItemSchema,
  isIntakeRecordId,
  MAX_SEALED_BYTES,
  parseCard,
  parseConfig,
  parseIntakeItem,
  RECORD_ID_PATTERN,
  ticketCard,
  type BoardCard,
  type BoardChange,
  type BoardConfig,
  type RecordValue,
} from "./project-board-records";
import { socketAgentDataDir } from "./socket-agent-paths";
import { errorMessage, isRecord } from "./value-guards";

/*
 * Project boards on this computer (docs/project-boards.md, "Server"). The app
 * grants each board's secret; this store keeps a local copy of every granted
 * board, pulls from the relay before turns and writes, and queues writes in
 * an outbox so chats keep working while the relay is unreachable.
 */

type HeldBoardKey = Pick<BoardGrant, "projectId" | "name" | "secret">;

export interface BoardGrant {
  projectId: string;
  name: string;
  secret: string;
  sessionIds: string[];
}

/** A chat that joined a board project on this computer before the app's grant listed it. */
interface LocalMember {
  projectId: string;
  sessionId: string;
  /** Already announced again after a grant left it out. The next such grant drops it. */
  reannounced?: boolean;
}

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RETRY_MS = 60_000;
const MAX_CONFLICT_RETRIES = 4;

const grantsFileSchema = z.object({
  v: z.literal(1),
  boards: z.array(z.object({
    projectId: z.string(),
    name: z.string(),
    secret: z.string(),
    sessionIds: z.array(z.string()),
  })),
  members: z.array(z.object({ projectId: z.string(), sessionId: z.string(), reannounced: z.boolean().optional() })).default([]),
  gone: z.array(z.string()).default([]),
  held: z.array(z.object({ projectId: z.string(), name: z.string(), secret: z.string() })).default([]),
});
const cacheFileSchema = z.object({
  v: z.literal(1),
  boardId: z.string(),
  seq: z.number().int().nonnegative(),
  records: z.record(z.string(), z.object({ version: z.number().int().nonnegative(), value: z.record(z.string(), z.unknown()) })),
  /** Intake items pulled but not yet claimed, record ID to ciphertext. */
  intake: z.record(z.string(), z.string()).default({}),
});
const outboxEntrySchema = z.object({
  id: z.string(),
  recordId: z.string(),
  queuedAt: z.number(),
  change: z.custom<BoardChange>(isBoardChange),
});
const outboxFileSchema = z.object({ v: z.literal(1), entries: z.array(outboxEntrySchema) });
const deliveredFileSchema = z.record(z.string(), z.string());

type OutboxEntry = z.output<typeof outboxEntrySchema>;
interface CachedRecord {
  version: number;
  value: RecordValue;
}

function isBoardChange(value: unknown): value is BoardChange {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "create": return isRecord(value.card);
    case "propose": return isRecord(value.proposal);
    case "update": return typeof value.cardId === "string" && isRecord(value.changes) && typeof value.at === "number";
    case "delete": return typeof value.cardId === "string" && typeof value.at === "number";
    case "move": return typeof value.cardId === "string" && typeof value.from === "string"
      && typeof value.to === "string" && typeof value.why === "string" && typeof value.by === "string"
      && typeof value.at === "number";
    case "intake": return typeof value.cardId === "string" && typeof value.itemId === "string"
      && typeof value.at === "number" && intakeItemSchema.safeParse(value.item).success;
    default: return false;
  }
}

function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

function readJson<T extends z.ZodType>(file: string, schema: T): z.output<T> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return schema.parse(parsed);
  } catch (error: unknown) {
    console.warn(`[ProjectBoards] Ignoring unreadable ${file}: ${errorMessage(error)}`);
    return null;
  }
}

/** What a write did: saved on the relay, saved locally until the relay answers, or refused. */
export type BoardWriteOutcome =
  | { ok: true; pending: boolean; value: RecordValue }
  | { ok: false; error: string };

export interface BoardSyncState {
  /** Whether the last relay request succeeded. */
  online: boolean;
  /** Writes waiting in the outbox. */
  pending: number;
}

/** The local copy of one granted board. Every relay exchange runs one at a time. */
export class BoardReplica {
  private seq = 0;
  private readonly records = new Map<string, CachedRecord>();
  /**
   * Intake items at version 1 that this computer pulled and has not claimed,
   * record ID to intake box. Kept in the cache, because the next pull starts
   * after them.
   */
  private readonly intake = new Map<string, string>();
  private outbox: OutboxEntry[] = [];
  private readonly failures = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | null = null;
  /** Why the relay turned away the last flush (429 or 503), until a request succeeds. */
  private refusal: string | null = null;
  private online = true;
  private gone = false;

  constructor(
    readonly projectId: string,
    /** The grant's secret, to notice when the app rotates the board. */
    readonly secret: string,
    private readonly keys: BoardKeys,
    private readonly dir: string,
    private readonly relay: ProjectBoardRelay | null,
    private readonly onGone: () => void,
  ) {
    const cache = readJson(this.cacheFile, cacheFileSchema);
    // A cache from an earlier secret belongs to a rotated board; its records
    // were copied to this one. Queued changes are intent, so they still apply.
    if (cache && cache.boardId === keys.boardId) {
      this.seq = cache.seq;
      for (const [id, record] of Object.entries(cache.records)) this.records.set(id, record);
      for (const [id, ciphertext] of Object.entries(cache.intake)) this.intake.set(id, ciphertext);
    }
    this.outbox = readJson(this.outboxFile, outboxFileSchema)?.entries ?? [];
  }

  get boardId(): string { return this.keys.boardId; }
  private get boardKey(): Uint8Array { return this.keys.boardKey; }
  private get cacheFile(): string { return path.join(this.dir, "cache.json"); }
  private get outboxFile(): string { return path.join(this.dir, "outbox.json"); }

  /** Pulls new records, sends queued writes and turns intake items into cards. Never throws for an unreachable relay. */
  sync(): Promise<BoardSyncState> {
    return this.serialize(async () => {
      await this.pullLocked();
      await this.flushLocked();
      await this.handleIntakeLocked();
      // Nobody waits on a change dropped by a background flush; it was logged.
      this.failures.clear();
    }).then(() => this.state(), (error: unknown) => {
      if (!(error instanceof BoardGoneError)) console.warn(`[ProjectBoards] ${this.projectId}: sync failed: ${errorMessage(error)}`);
      return this.state();
    });
  }

  state(): BoardSyncState {
    return { online: this.online, pending: this.outbox.length };
  }

  /** Records as this computer sees them: the relay's copy with queued writes applied. */
  view(): Map<string, RecordValue> {
    const view = new Map([...this.records].map(([id, record]) => [id, record.value]));
    const config = parseConfig(view.get(CONFIG_RECORD));
    for (const entry of this.outbox) {
      const result = applyChange(view.get(entry.recordId), entry.change, config);
      if (result.ok) view.set(entry.recordId, result.value);
    }
    return view;
  }

  config(view = this.view()): BoardConfig {
    return parseConfig(view.get(CONFIG_RECORD));
  }

  cards(view = this.view()): BoardCard[] {
    const cards: BoardCard[] = [];
    for (const [id, value] of view) {
      if (!id.startsWith("card.")) continue;
      const card = parseCard(value);
      if (card) cards.push(card);
    }
    return cards;
  }

  /**
   * Pulls, checks [change] against the current board, queues it and tries to
   * send it. A change refused now, or after a conflict is reapplied, returns
   * the reason.
   */
  write(change: BoardChange): Promise<BoardWriteOutcome> {
    const recordId = changeRecordId(change);
    if (!RECORD_ID_PATTERN.test(recordId)) return Promise.resolve({ ok: false, error: `Invalid record ID ${recordId}` });
    return this.serialize(async (): Promise<BoardWriteOutcome> => {
      await this.pullLocked();
      const { outcome, entry } = await this.queueLocked(change);
      this.failures.clear();
      if (outcome.ok && outcome.pending && entry && this.refusal) {
        // The relay is up but turned this write away. The agent learns that
        // now instead of the change surfacing later, unexpectedly.
        this.drop([entry]);
        return { ok: false, error: `${this.refusal}. Nothing was saved; try again in a minute.` };
      }
      return outcome;
    }).catch((error: unknown): BoardWriteOutcome => ({
      ok: false,
      error: error instanceof BoardGoneError
        ? "This board was turned off or replaced in the app, so it is no longer available on this computer."
        : errorMessage(error),
    }));
  }

  /**
   * Checks [change] against this computer's view, queues it and flushes the
   * outbox. The entry is returned while it is still queued.
   */
  private async queueLocked(change: BoardChange): Promise<{ outcome: BoardWriteOutcome; entry?: OutboxEntry }> {
    const recordId = changeRecordId(change);
    const view = this.view();
    const result = applyChange(view.get(recordId), change, this.config(view));
    if (!result.ok) return { outcome: result };
    const problem = sealedSizeProblem(result.value);
    if (problem) return { outcome: { ok: false, error: problem } };
    const entry: OutboxEntry = { id: randomBytes(8).toString("hex"), recordId, queuedAt: Date.now(), change };
    this.outbox.push(entry);
    this.saveOutbox();
    await this.flushLocked();
    const failure = this.failures.get(entry.id);
    if (failure) return { outcome: { ok: false, error: failure } };
    const pending = this.outbox.some((queued) => queued.id === entry.id);
    return { outcome: { ok: true, pending, value: this.view().get(recordId) ?? result.value }, ...(pending ? { entry } : {}) };
  }

  /**
   * Turns each pulled intake item into a card change through the outbox, then
   * claims the item so no computer applies it again ("Turning items into
   * cards"). An item waits while its card change is unsent, and is claimed
   * with an error when it can't be opened, parsed or applied.
   */
  private async handleIntakeLocked(): Promise<void> {
    const relay = this.relay;
    if (!relay || !this.online || !this.intake.size) return;
    for (const [recordId, ciphertext] of [...this.intake]) {
      if (!this.online) break;
      const itemId = intakeItemId(recordId);
      if (this.outbox.some((entry) => entry.change.kind === "intake" && entry.change.itemId === itemId)) continue;
      let error: string | undefined;
      const plaintext = openIntakeBox(this.keys.boxSecret, ciphertext);
      const parsed = plaintext === null
        ? { ok: false, error: "The item could not be opened with this board's box key." } satisfies ReturnType<typeof parseIntakeItem>
        : parseIntakeItem(plaintext);
      if (parsed.ok) {
        const { item } = parsed;
        // The item's own card when it has one, a deleted one included, so the
        // user's delete holds. Otherwise a card already linking the ticket,
        // such as one an agent made before the service was connected.
        const ownId = intakeCardId(item.source, item.ref);
        const view = this.view();
        const cardId = view.has(cardRecordId(ownId))
          ? ownId
          : ticketCard(this.cards(view), [item.ref, item.url ?? ""], this.config(view))?.id ?? ownId;
        const { outcome } = await this.queueLocked({ kind: "intake", cardId, itemId, item, at: Date.now() });
        if (outcome.ok && outcome.pending) continue;
        if (!outcome.ok) error = outcome.error;
      } else {
        error = parsed.error;
      }
      // A pull during the write may have brought another computer's claim.
      if (!this.intake.has(recordId)) continue;
      if (error) console.warn(`[ProjectBoards] ${this.projectId}: intake item ${itemId} not applied: ${error}`);
      if (!await this.claimIntakeLocked(relay, recordId, itemId, error)) break;
    }
    this.scheduleRetry();
  }

  /** Writes the handled marker over an intake item. False when the relay could not take it now. */
  private async claimIntakeLocked(relay: ProjectBoardRelay, recordId: string, itemId: string, error?: string): Promise<boolean> {
    const claim = { v: 1, id: itemId, handled: true, at: Date.now(), ...(error ? { error: error.slice(0, 1000) } : {}) };
    try {
      await relay.put(recordId, 1, sealBoardRecord(this.boardKey, JSON.stringify(claim)));
    } catch (failure: unknown) {
      if (failure instanceof BoardGoneError) throw failure;
      if (failure instanceof BoardRejectedError) {
        console.warn(`[ProjectBoards] ${this.projectId}: could not mark intake item ${itemId} handled: ${failure.message}`);
      } else if (!(failure instanceof BoardConflictError)) {
        // A 409 means another computer handled it. Anything else waits for the next sync.
        this.online = false;
        this.refusal = failure instanceof BoardUnavailableError ? `The relay is not taking board writes now: ${failure.message}` : null;
        return false;
      }
    }
    this.intake.delete(recordId);
    this.saveCache();
    return true;
  }

  /** Stops the retry timer. The local files stay for the next start. */
  close(): void {
    this.gone = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      if (this.gone) throw new BoardGoneError();
      return work();
    });
    this.queue = run.catch(() => undefined);
    return run.catch((error: unknown) => {
      if (error instanceof BoardGoneError && !this.gone) {
        this.close();
        this.onGone();
      }
      throw error;
    });
  }

  /** Best effort: an unreachable relay leaves the cache as it was. */
  private async pullLocked(): Promise<void> {
    if (!this.relay) return;
    try {
      let list = await this.relay.list(this.seq);
      if (list.seq < this.seq) {
        // The relay's counter went backwards, so its copy was replaced. Start over.
        this.seq = 0;
        this.records.clear();
        this.intake.clear();
        list = await this.relay.list(0);
      }
      for (const record of list.records) {
        if (!RECORD_ID_PATTERN.test(record.id)) continue;
        if (isIntakeRecordId(record.id)) {
          // Version 1 is a service's item; a later version is a computer's
          // claim, which needs nothing and is not part of the board's view.
          if (record.version === 1) this.intake.set(record.id, record.ciphertext);
          else this.intake.delete(record.id);
          continue;
        }
        const value = this.decode(record.ciphertext);
        if (value) this.records.set(record.id, { version: record.version, value });
        else console.warn(`[ProjectBoards] ${this.projectId}: could not open record ${record.id}`);
      }
      this.seq = Math.max(this.seq, list.seq);
      this.online = true;
      this.refusal = null;
      this.saveCache();
    } catch (error: unknown) {
      if (error instanceof BoardGoneError) throw error;
      // Any other failure, a refusal or an unreadable answer included, leaves the cache as it was.
      this.online = false;
      this.refusal = error instanceof BoardUnavailableError ? `The relay is not taking board requests now: ${error.message}` : null;
      this.scheduleRetry();
    }
  }

  private decode(ciphertext: string): RecordValue | null {
    const plaintext = openBoardRecord(this.boardKey, ciphertext);
    if (plaintext === null) return null;
    try {
      const value: unknown = JSON.parse(plaintext);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Sends queued writes one record at a time. Each record's queued changes
   * are applied to the relay's current copy; a 409 pulls and applies them
   * again, and a change that no longer fits is dropped with its reason.
   */
  private async flushLocked(): Promise<void> {
    if (!this.relay) return;
    if (!this.online) {
      // The pull just failed; the retry timer sends the outbox once the relay answers.
      this.scheduleRetry();
      return;
    }
    const recordIds = [...new Set(this.outbox.map((entry) => entry.recordId))];
    for (const recordId of recordIds) {
      for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
        const done = await this.flushRecord(recordId);
        if (done === "offline") {
          this.scheduleRetry();
          return;
        }
        if (done === "done") break;
        await this.pullLocked();
        if (!this.online) {
          this.scheduleRetry();
          return;
        }
      }
    }
    if (this.outbox.length) this.scheduleRetry();
  }

  private async flushRecord(recordId: string): Promise<"done" | "conflict" | "offline"> {
    const relay = this.relay;
    if (!relay) return "offline";
    const base = this.records.get(recordId);
    const config = parseConfig(this.records.get(CONFIG_RECORD)?.value);
    let value = base?.value;
    const applied: OutboxEntry[] = [];
    for (const entry of this.outbox.filter((queued) => queued.recordId === recordId)) {
      const result = applyChange(value, entry.change, config);
      if (result.ok) {
        value = result.value;
        applied.push(entry);
      } else {
        this.drop([entry], result.error);
      }
    }
    if (!applied.length || !value) return "done";
    if (base && JSON.stringify(base.value) === JSON.stringify(value)) {
      this.drop(applied);
      return "done";
    }
    const plaintext = JSON.stringify(value);
    const problem = sealedSizeProblem(value);
    if (problem) {
      this.drop(applied, problem);
      return "done";
    }
    try {
      const saved = await relay.put(recordId, base?.version ?? 0, sealBoardRecord(this.boardKey, plaintext));
      this.records.set(recordId, { version: saved.version, value });
      this.online = true;
      this.refusal = null;
      this.drop(applied);
      this.saveCache();
      return "done";
    } catch (error: unknown) {
      if (error instanceof BoardGoneError) throw error;
      if (error instanceof BoardConflictError) return "conflict";
      if (error instanceof BoardRejectedError) {
        this.drop(applied, error.message);
        return "done";
      }
      this.online = false;
      this.refusal = error instanceof BoardUnavailableError ? `The relay is not taking board writes now: ${error.message}` : null;
      return "offline";
    }
  }

  /** Removes entries from the outbox, recording [error] for writers still waiting on them. */
  private drop(entries: OutboxEntry[], error?: string): void {
    const ids = new Set(entries.map((entry) => entry.id));
    this.outbox = this.outbox.filter((entry) => !ids.has(entry.id));
    if (error) {
      for (const entry of entries) {
        this.failures.set(entry.id, error);
        console.warn(`[ProjectBoards] ${this.projectId}: dropped a ${entry.change.kind} of ${entry.recordId}: ${error}`);
      }
    }
    this.saveOutbox();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.gone || (!this.outbox.length && !this.intake.size)) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.sync();
    }, RETRY_MS);
    this.retryTimer.unref();
  }

  private saveCache(): void {
    writePrivateJson(this.cacheFile, {
      v: 1,
      boardId: this.boardId,
      seq: this.seq,
      records: Object.fromEntries(this.records),
      intake: Object.fromEntries(this.intake),
    });
  }

  private saveOutbox(): void {
    writePrivateJson(this.outboxFile, { v: 1, entries: this.outbox });
  }
}

function sealedSizeProblem(value: RecordValue): string | null {
  const bytes = sealedRecordBytes(JSON.stringify(value));
  return bytes > MAX_SEALED_BYTES
    ? `The card is ${bytes} bytes sealed; the limit is ${MAX_SEALED_BYTES} (64 KiB). Shorten detail or notes.`
    : null;
}

export interface ProjectBoardStoreOptions {
  dataDir: string;
  relayUrl: string | undefined;
  fetch?: BoardFetch;
}

/** Every board granted to this computer, keyed by project. */
export class ProjectBoardStore {
  readonly relayBase: string | null;
  private grants: BoardGrant[] = [];
  private members: LocalMember[] = [];
  /** Board IDs the relay answered 410 for. A grant with one of these secrets is stale. */
  private gone: string[] = [];
  /**
   * Secrets of boards the app's grants stopped listing. The app may have lost
   * a board it never turned off, and asks for its key back with
   * project_board_key_request; dropping the key with the grant would lose the
   * board's cards for good. Newest last, at most 50.
   */
  private held: HeldBoardKey[] = [];
  private readonly replicas = new Map<string, BoardReplica>();
  private delivered: Record<string, string>;

  constructor(private readonly options: ProjectBoardStoreOptions) {
    this.relayBase = relayHttpBase(options.relayUrl);
    const saved = readJson(this.grantsFile, grantsFileSchema);
    if (saved) {
      this.gone = saved.gone;
      this.grants = saved.boards.filter((grant) => this.usableGrant(grant));
      this.held = saved.held.filter((key) => this.usableGrant({ ...key, sessionIds: [] }));
      this.members = saved.members.filter((member) => this.grants.some((grant) => grant.projectId === member.projectId));
    }
    this.delivered = readJson(this.deliveredFile, deliveredFileSchema) ?? {};
  }

  private get grantsFile(): string { return path.join(this.options.dataDir, "project-boards.json"); }
  private get boardsDir(): string { return path.join(this.options.dataDir, "boards"); }
  private get deliveredFile(): string { return path.join(this.boardsDir, "delivered.json"); }

  private usableGrant(grant: BoardGrant): boolean {
    if (!PROJECT_ID_PATTERN.test(grant.projectId)) {
      console.warn(`[ProjectBoards] Ignoring a grant with an unusable project ID`);
      return false;
    }
    const secret = decodeBoardSecret(grant.secret);
    if (!secret) {
      console.warn(`[ProjectBoards] Ignoring the grant for ${grant.projectId}: its secret is not 32 bytes of base64`);
      return false;
    }
    if (this.gone.includes(deriveBoardKeys(secret).boardId)) {
      console.warn(`[ProjectBoards] Ignoring the grant for ${grant.projectId}: the relay says that board is gone`);
      return false;
    }
    return true;
  }

  /**
   * Replaces every grant with the app's latest list. A project left out loses
   * its board here. Returns chats that joined a board project on this computer
   * but are missing from the grant, so the app can be told once more; the app
   * may have been offline for the first notice. A chat still missing from the
   * grant after that follows the grant, so the user's own moves win.
   */
  replaceGrants(boards: BoardGrant[]): { projectId: string; sessionId: string }[] {
    const next = new Map<string, BoardGrant>();
    for (const grant of boards) {
      if (this.usableGrant(grant)) next.set(grant.projectId, { ...grant, sessionIds: [...new Set(grant.sessionIds)] });
    }
    for (const old of this.grants) {
      if (next.get(old.projectId)?.secret === old.secret) continue;
      this.held = [
        ...this.held.filter((key) => key.secret !== old.secret),
        { projectId: old.projectId, name: old.name, secret: old.secret },
      ].slice(-50);
    }
    this.grants = [...next.values()];
    const granted = new Set(this.grants.flatMap((grant) => grant.sessionIds));
    this.members = this.members
      .filter((member) => next.has(member.projectId) && !granted.has(member.sessionId) && !member.reannounced)
      .map((member) => ({ ...member, reannounced: true }));
    for (const [projectId, replica] of this.replicas) {
      const grant = next.get(projectId);
      if (!grant || grant.secret !== replica.secret) {
        replica.close();
        this.replicas.delete(projectId);
      }
    }
    // A project the app still names keeps its folder even when its secret is
    // stale, so changes queued there reach the board once a new secret arrives.
    this.removeFoldersExcept(new Set(boards.map((grant) => grant.projectId)));
    this.saveGrants();
    console.log(`[ProjectBoards] Holding ${this.grants.length} board grant(s)`);
    return this.members.map(({ projectId, sessionId }) => ({ projectId, sessionId }));
  }

  /** Records that [sessionId] joined [projectId] on this computer. False when the project has no board here. */
  addMember(projectId: string, sessionId: string): boolean {
    if (!this.grants.some((grant) => grant.projectId === projectId)) return false;
    if (this.projectFor(sessionId) === projectId) return true;
    this.members = [...this.members.filter((member) => member.sessionId !== sessionId), { projectId, sessionId }];
    this.saveGrants();
    return true;
  }

  /**
   * The board project [sessionId] belongs to. [hint] is the parent's project
   * of a new child agent and counts only while the child has no session ID.
   */
  projectFor(sessionId: string, hint?: string | null): string | null {
    if (sessionId) {
      const grant = this.grants.find((candidate) => candidate.sessionIds.includes(sessionId));
      if (grant) return grant.projectId;
      return this.members.find((candidate) => candidate.sessionId === sessionId)?.projectId ?? null;
    }
    return hint && this.grants.some((grant) => grant.projectId === hint) ? hint : null;
  }

  /** Every board granted to this computer, by project. */
  boards(): { projectId: string; name: string }[] {
    return this.grants.map(({ projectId, name }) => ({ projectId, name }));
  }

  grant(projectId: string): BoardGrant | undefined {
    return this.grants.find((grant) => grant.projectId === projectId);
  }

  /** The key this computer holds for [projectId]'s board: its grant's, or the newest one a grant dropped. */
  heldKey(projectId: string): string | undefined {
    return this.grant(projectId)?.secret
      ?? this.held.filter((key) => key.projectId === projectId).at(-1)?.secret;
  }

  /** The local copy of [projectId]'s board. Null without a grant or a relay. */
  board(projectId: string): BoardReplica | null {
    const existing = this.replicas.get(projectId);
    if (existing) return existing;
    const grant = this.grant(projectId);
    const secret = grant ? decodeBoardSecret(grant.secret) : null;
    if (!grant || !secret || !this.relayBase) return null;
    const keys = deriveBoardKeys(secret);
    const relay = new ProjectBoardRelay(this.relayBase, keys, this.options.fetch);
    const replica = new BoardReplica(projectId, grant.secret, keys,
      path.join(this.boardsDir, projectId), relay, () => this.dropBoard(projectId));
    this.replicas.set(projectId, replica);
    return replica;
  }

  /** Pulls every granted board in the background, so the first turn finds a warm cache. */
  syncAll(): void {
    for (const grant of this.grants) void this.board(grant.projectId)?.sync();
  }

  /** The relay answered 410: the board was rotated or turned off. Its grant stays dropped until a new secret arrives. */
  private dropBoard(projectId: string): void {
    console.log(`[ProjectBoards] The relay no longer has the board for ${projectId}; dropping its grant`);
    const boardId = this.replicas.get(projectId)?.boardId;
    if (boardId) this.gone = [...this.gone.filter((id) => id !== boardId), boardId].slice(-200);
    const secret = this.replicas.get(projectId)?.secret;
    this.held = this.held.filter((key) => key.secret !== secret);
    this.replicas.delete(projectId);
    this.grants = this.grants.filter((grant) => grant.projectId !== projectId);
    this.members = this.members.filter((member) => member.projectId !== projectId);
    // The outbox stays: when the board was rotated, the grant with the new
    // secret replays those changes on the new board. A grant without the
    // project removes the folder.
    fs.rmSync(path.join(this.boardsDir, projectId, "cache.json"), { force: true });
    this.saveGrants();
  }

  /** The digest of the board instructions [sessionId] last received. */
  deliveredDigest(sessionId: string): string | undefined {
    return this.delivered[sessionId];
  }

  /** Records what [sessionId] last received. Null forgets it, so the next turn delivers again. */
  setDeliveredDigest(sessionId: string, digest: string | null): void {
    if (!sessionId || (this.delivered[sessionId] ?? null) === digest) return;
    if (digest === null) delete this.delivered[sessionId];
    else this.delivered[sessionId] = digest;
    try {
      writePrivateJson(this.deliveredFile, this.delivered);
    } catch (error: unknown) {
      // Kept in memory; at worst a restart delivers the block once more.
      console.warn(`[ProjectBoards] Could not save delivered digests: ${errorMessage(error)}`);
    }
  }

  private removeFoldersExcept(projectIds: Set<string>): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.boardsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !projectIds.has(entry.name)) {
        fs.rmSync(path.join(this.boardsDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  private saveGrants(): void {
    writePrivateJson(this.grantsFile, { v: 1, boards: this.grants, members: this.members, gone: this.gone, held: this.held });
  }
}

let shared: ProjectBoardStore | null = null;

/** The store for this server, created on first use from the data folder and RELAY_URL. */
export function projectBoards(): ProjectBoardStore {
  shared ??= new ProjectBoardStore({ dataDir: socketAgentDataDir(), relayUrl: process.env.RELAY_URL });
  return shared;
}

/** Replaces the shared store, so tests can point it at a fake relay. */
export function setProjectBoardStore(store: ProjectBoardStore): void {
  shared = store;
}
