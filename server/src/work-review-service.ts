import * as crypto from "crypto";
import {
  CreateWorkReviewInput,
  CreateWorkReviewRoundInput,
  FinishWorkReviewInput,
  FinishWorkReviewResult,
  MAX_WORK_REVIEW_ITEMS,
  MAX_WORK_REVIEW_SUPPORTING_TARGETS,
  MAX_WORK_REVIEW_TOTAL_BYTES,
  StoredWorkReviewRecord,
  StoredWorkReviewRound,
  UpdateWorkReviewDraftInput,
  WORK_REVIEW_SCHEMA_VERSION,
  WorkReviewAgentRoundView,
  WorkReviewAgentSummary,
  WorkReviewAgentView,
  WorkReviewClientSnapshot,
  WorkReviewDisplayMode,
  WorkReviewDraft,
  WorkReviewError,
  WorkReviewEventType,
  WorkReviewExport,
  WorkReviewItem,
  WorkReviewItemInput,
  WorkReviewItemStatus,
  WorkReviewListFilter,
  WorkReviewPublishedResult,
  WorkReviewRoundContentInput,
  WorkReviewTarget,
  WorkReviewTargetInput,
  WorkReviewTargetKind,
} from "./work-review-types";
import { WorkReviewStore } from "./work-review-store";

const targetKinds = new Set<WorkReviewTargetKind>([
  "url", "file", "image", "html", "diff", "session", "custom",
]);
const displayModes = new Set<WorkReviewDisplayMode>(["auto", "embedded", "external"]);
const itemStatuses = new Set<WorkReviewItemStatus>([
  "pending", "approved", "changes_requested", "rejected", "skipped",
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function boundedString(
  value: unknown,
  name: string,
  maximum: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new WorkReviewError("validation", `${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new WorkReviewError("validation", `${name} must be a string`);
  const cleaned = value.trim();
  if (required && !cleaned) throw new WorkReviewError("validation", `${name} is required`);
  if (!cleaned) return undefined;
  if (cleaned.length > maximum) {
    throw new WorkReviewError("validation", `${name} exceeds ${maximum} characters`);
  }
  return cleaned;
}

function cleanId(value: unknown, name: string): string {
  const id = boundedString(value, name, 160, true)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new WorkReviewError("validation", `${name} contains unsupported characters`);
  }
  return id;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function validateUrl(uri: string): void {
  if (/[\u0000-\u001F\u007F]/.test(uri)) {
    throw new WorkReviewError("validation", "URL target contains control characters");
  }
  let parsed: URL;
  try { parsed = new URL(uri); } catch {
    throw new WorkReviewError("validation", "URL target must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WorkReviewError("validation", "URL targets support http and https");
  }
  if (!parsed.hostname) throw new WorkReviewError("validation", "URL target requires a hostname");
  if (parsed.username || parsed.password) {
    throw new WorkReviewError("validation", "URL target must not contain embedded credentials");
  }
  // Deliberately allow localhost, LAN, preview, sandbox, and production hosts.
}

function cleanTarget(input: WorkReviewTargetInput, generatedId?: string): WorkReviewTarget {
  if (!input || typeof input !== "object" || !targetKinds.has(input.kind)) {
    throw new WorkReviewError("validation", "Target kind is invalid");
  }
  const uri = boundedString(input.uri, "Target URI", 4096, true)!;
  if (input.kind === "url") validateUrl(uri);
  const displayMode = input.displayMode || "auto";
  if (!displayModes.has(displayMode)) {
    throw new WorkReviewError("validation", "Target display mode is invalid");
  }
  return {
    targetId: generatedId || crypto.randomUUID(),
    kind: input.kind,
    uri,
    displayMode,
    ...(boundedString(input.label, "Target label", 200) ? { label: input.label!.trim() } : {}),
    ...(boundedString(input.environment, "Target environment", 100)
      ? { environment: input.environment!.trim() }
      : {}),
    ...(boundedString(input.description, "Target description", 4_000)
      ? { description: input.description!.trim() }
      : {}),
  };
}

function cleanItem(input: WorkReviewItemInput, index: number): WorkReviewItem {
  if (!input || typeof input !== "object") {
    throw new WorkReviewError("validation", `Item ${index + 1} is invalid`);
  }
  const supporting = input.supportingTargets || [];
  if (!Array.isArray(supporting) || supporting.length > MAX_WORK_REVIEW_SUPPORTING_TARGETS) {
    throw new WorkReviewError(
      "validation",
      `Item ${index + 1} may have at most ${MAX_WORK_REVIEW_SUPPORTING_TARGETS} supporting targets`,
    );
  }
  const itemId = input.itemId ? cleanId(input.itemId, "Item ID") : `item-${index + 1}`;
  const primaryTarget = cleanTarget(input.primaryTarget, `${itemId}:primary`);
  // A primary web target is the surface being reviewed. It must stay inside
  // the app beneath the review panel; the app provides a separate explicit
  // action for opening it externally.
  if (primaryTarget.kind === "url") {
    primaryTarget.displayMode = "embedded";
  }
  return {
    itemId,
    title: boundedString(input.title, "Item title", 300, true)!,
    ...(boundedString(input.description, "Item description", 20_000)
      ? { description: input.description!.trim() }
      : {}),
    ...(boundedString(input.instructions, "Item instructions", 20_000)
      ? { instructions: input.instructions!.trim() }
      : {}),
    primaryTarget,
    supportingTargets: supporting.map((target, targetIndex) =>
      cleanTarget(target, `${itemId}:supporting:${targetIndex + 1}`)),
  };
}

function cleanRoundContent(input: WorkReviewRoundContentInput): Omit<
  StoredWorkReviewRound,
  "roundId" | "revision" | "createdAt" | "status" | "idempotencyKeyHash" | "contentHash" | "draft"
> {
  if (!input || typeof input !== "object") {
    throw new WorkReviewError("validation", "Work review content is required");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new WorkReviewError("validation", "A work review requires at least one item");
  }
  if (input.items.length > MAX_WORK_REVIEW_ITEMS) {
    throw new WorkReviewError("validation", `A work review may have at most ${MAX_WORK_REVIEW_ITEMS} items`);
  }
  const items = input.items.map(cleanItem);
  const ids = new Set(items.map((item) => item.itemId));
  if (ids.size !== items.length) throw new WorkReviewError("validation", "Work review item IDs must be unique");
  const content = {
    title: boundedString(input.title, "Work review title", 300, true)!,
    ...(boundedString(input.purpose, "Work review purpose", 4_000)
      ? { purpose: input.purpose!.trim() }
      : {}),
    ...(boundedString(input.summary, "Work review summary", 40_000)
      ? { summary: input.summary!.trim() }
      : {}),
    ...(boundedString(input.instructions, "Work review instructions", 40_000)
      ? { instructions: input.instructions!.trim() }
      : {}),
    ...(boundedString(input.approvalMeaning, "Approval meaning", 4_000)
      ? { approvalMeaning: input.approvalMeaning!.trim() }
      : {}),
    items,
  };
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_WORK_REVIEW_TOTAL_BYTES) {
    throw new WorkReviewError(
      "validation",
      `Work review content exceeds ${Math.round(MAX_WORK_REVIEW_TOTAL_BYTES / 1024)} KB`,
    );
  }
  return content;
}

function initialDraft(items: WorkReviewItem[], now: string): WorkReviewDraft {
  return {
    revision: 0,
    updatedAt: now,
    itemDecisions: items.map((item) => ({ itemId: item.itemId, status: "pending" })),
  };
}

function agentRound(round: StoredWorkReviewRound): WorkReviewAgentRoundView {
  return {
    roundId: round.roundId,
    revision: round.revision,
    title: round.title,
    ...(round.purpose ? { purpose: round.purpose } : {}),
    ...(round.summary ? { summary: round.summary } : {}),
    ...(round.instructions ? { instructions: round.instructions } : {}),
    ...(round.approvalMeaning ? { approvalMeaning: round.approvalMeaning } : {}),
    items: clone(round.items),
    createdAt: round.createdAt,
    status: round.status,
    ...(round.status === "completed" && round.result ? { result: clone(round.result) } : {}),
  };
}

function agentView(record: StoredWorkReviewRecord): WorkReviewAgentView {
  return {
    reviewId: record.reviewId,
    cardId: record.cardId,
    originSessionId: record.originSessionId,
    ...(record.originBackend ? { originBackend: record.originBackend } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
    currentRevision: record.currentRevision,
    rounds: record.rounds.map(agentRound),
    events: clone(record.events),
  };
}

function currentRound(record: StoredWorkReviewRecord): StoredWorkReviewRound {
  return record.rounds[record.currentRevision];
}

/**
 * Domain service with per-review promise queues. Every mutation for one review
 * is serialized, while unrelated reviews remain independent.
 */
export class WorkReviewService {
  private readonly mutationQueues = new Map<string, Promise<void>>();

  constructor(public readonly store: WorkReviewStore = new WorkReviewStore()) {}

  private appendEvent(
    record: StoredWorkReviewRecord,
    type: WorkReviewEventType,
    at: string,
    draftRevision?: number,
  ): void {
    record.events.push({
      eventId: crypto.randomUUID(),
      type,
      at,
      revision: record.currentRevision,
      ...(draftRevision !== undefined ? { draftRevision } : {}),
    });
  }

  private applyDraftUpdate(
    record: StoredWorkReviewRecord,
    input: UpdateWorkReviewDraftInput & { itemDecisions?: UpdateWorkReviewDraftInput["itemUpdates"] },
    now: string,
  ): { changed: boolean; retry: boolean; retryDraft?: WorkReviewDraft } {
    const round = currentRound(record);
    const mutationId = input.mutationId
      ? boundedString(input.mutationId, "Draft mutation ID", 300, true)!
      : undefined;
    const mutationIdHash = mutationId ? hash({ reviewId: record.reviewId, mutationId }) : undefined;
    const mutationContentHash = mutationId ? hash(input) : undefined;
    if (mutationIdHash) {
      const receipt = round.draftMutations?.find((entry) => entry.mutationIdHash === mutationIdHash);
      if (receipt) {
        if (receipt.contentHash !== mutationContentHash) {
          throw new WorkReviewError(
            "idempotency_conflict",
            "Draft mutation ID was already used for different content",
          );
        }
        return { changed: false, retry: true, retryDraft: clone(receipt.resultDraft) };
      }
    }
    if (round.status !== "in_review" || !round.draft) {
      throw new WorkReviewError("invalid_state", "Completed work review rounds are immutable");
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== round.draft.revision) {
      throw new WorkReviewError("revision_conflict", "Work review draft has changed");
    }
    const isReplacement = input.itemDecisions !== undefined;
    const updates = input.itemDecisions ?? input.itemUpdates ?? [];
    if (!Array.isArray(updates)) {
      throw new WorkReviewError("validation", "Item updates must be an array");
    }
    if (
      updates.length > round.items.length
      || (isReplacement && updates.length !== round.items.length)
    ) {
      throw new WorkReviewError(
        "validation",
        isReplacement
          ? "Final item decisions must contain every work review item"
          : "Too many work review item updates",
      );
    }
    const decisions = new Map(round.draft.itemDecisions.map((decision) => [decision.itemId, decision]));
    const seen = new Set<string>();
    for (const update of updates) {
      const itemId = cleanId(update?.itemId, "Item ID");
      if (seen.has(itemId)) throw new WorkReviewError("validation", "Duplicate item update");
      seen.add(itemId);
      if (!decisions.has(itemId)) throw new WorkReviewError("validation", `Unknown work review item ${itemId}`);
      if (!itemStatuses.has(update.status)) {
        throw new WorkReviewError("validation", `Invalid status for work review item ${itemId}`);
      }
      const note = update.note === null
        ? undefined
        : boundedString(update.note, "Item note", 40_000);
      decisions.set(itemId, {
        itemId,
        status: update.status,
        ...(note ? { note } : {}),
      });
    }
    if (isReplacement && round.items.some((item) => !seen.has(item.itemId))) {
      throw new WorkReviewError("validation", "Final item decisions must contain every work review item");
    }
    const overallNote = input.overallNote === undefined
      ? round.draft.overallNote
      : input.overallNote === null
        ? undefined
        : boundedString(input.overallNote, "Overall note", 80_000);
    const nextDraft: WorkReviewDraft = {
      revision: round.draft.revision + 1,
      updatedAt: now,
      itemDecisions: round.items.map((item) => clone(decisions.get(item.itemId)!)),
      ...(overallNote ? { overallNote } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(nextDraft), "utf8") > MAX_WORK_REVIEW_TOTAL_BYTES) {
      throw new WorkReviewError(
        "validation",
        `Work review draft exceeds ${Math.round(MAX_WORK_REVIEW_TOTAL_BYTES / 1024)} KB`,
      );
    }
    round.draft = nextDraft;
    if (mutationIdHash && mutationContentHash) {
      round.draftMutations = [
        ...(round.draftMutations || []),
        {
          mutationIdHash,
          contentHash: mutationContentHash,
          resultingRevision: round.draft.revision,
          resultDraft: clone(round.draft),
        },
      ].slice(-100);
    }
    return { changed: true, retry: false };
  }

  private async serialize<T>(reviewId: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(reviewId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    this.mutationQueues.set(reviewId, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationQueues.get(reviewId) === queued) this.mutationQueues.delete(reviewId);
    }
  }

  async create(input: CreateWorkReviewInput): Promise<WorkReviewAgentView> {
    const originSessionId = cleanId(input.originSessionId, "Origin session ID");
    const idempotencyKey = boundedString(input.idempotencyKey, "Idempotency key", 300, true)!;
    const content = cleanRoundContent(input);
    const originBackend = boundedString(input.originBackend, "Origin backend", 80);
    const contentHash = hash({ originSessionId, originBackend, ...content });
    const idempotencyKeyHash = hash({ originSessionId, idempotencyKey });
    const existing = this.store.findIdempotency(originSessionId, idempotencyKeyHash);
    if (existing) {
      if (existing.contentHash !== contentHash) {
        throw new WorkReviewError(
          "idempotency_conflict",
          "Idempotency key was already used for different work review content",
        );
      }
      const record = this.store.get(existing.reviewId);
      if (record) return agentView(record);
      this.store.rebuildIndex();
    }
    const reviewId = crypto.randomUUID();
    return this.serialize(`create:${idempotencyKeyHash}`, () => {
      const retry = this.store.findIdempotency(originSessionId, idempotencyKeyHash);
      if (retry) {
        if (retry.contentHash !== contentHash) {
          throw new WorkReviewError(
            "idempotency_conflict",
            "Idempotency key was already used for different work review content",
          );
        }
        const record = this.store.get(retry.reviewId);
        if (record) return agentView(record);
      }
      const now = new Date().toISOString();
      const round: StoredWorkReviewRound = {
        roundId: crypto.randomUUID(),
        revision: 0,
        ...content,
        createdAt: now,
        status: "in_review",
        idempotencyKeyHash,
        contentHash,
        draft: initialDraft(content.items, now),
      };
      const record: StoredWorkReviewRecord = {
        schemaVersion: WORK_REVIEW_SCHEMA_VERSION,
        reviewId,
        cardId: crypto.randomUUID(),
        originSessionId,
        ...(originBackend ? { originBackend } : {}),
        createdAt: now,
        updatedAt: now,
        currentRevision: 0,
        rounds: [round],
        events: [{
          eventId: crypto.randomUUID(),
          type: "created",
          at: now,
          revision: 0,
          draftRevision: 0,
        }],
      };
      return agentView(this.store.save(record));
    });
  }

  get(reviewId: string): WorkReviewAgentView | undefined {
    const record = this.store.get(reviewId);
    return record ? agentView(record) : undefined;
  }

  list(filter: WorkReviewListFilter = {}): WorkReviewAgentSummary[] {
    return this.store.list()
      .filter((record) =>
        (!filter.originSessionId || record.originSessionId === filter.originSessionId)
        && (filter.includeArchived || !record.archivedAt),
      )
      .map((record) => {
        const round = currentRound(record);
        return {
          reviewId: record.reviewId,
          cardId: record.cardId,
          originSessionId: record.originSessionId,
          ...(record.originBackend ? { originBackend: record.originBackend } : {}),
          title: round.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
          currentRevision: record.currentRevision,
          currentRoundId: round.roundId,
          status: round.status,
          itemCount: round.items.length,
        };
      });
  }

  clientSnapshot(reviewId: string): WorkReviewClientSnapshot | undefined {
    const record = this.store.get(reviewId);
    if (!record) return undefined;
    const view: WorkReviewClientSnapshot = agentView(record);
    const draft = currentRound(record).draft;
    if (draft) view.currentDraft = clone(draft);
    return view;
  }

  async updateDraft(reviewId: string, input: UpdateWorkReviewDraftInput): Promise<WorkReviewClientSnapshot> {
    return this.serialize(reviewId, () => {
      const record = this.store.get(reviewId);
      if (!record) throw new WorkReviewError("not_found", "Work review not found");
      if (record.archivedAt) throw new WorkReviewError("invalid_state", "Archived work reviews cannot be edited");
      const now = new Date().toISOString();
      const applied = this.applyDraftUpdate(record, input, now);
      if (applied.retry) {
        const snapshot = this.clientSnapshot(reviewId)!;
        if (applied.retryDraft) snapshot.currentDraft = applied.retryDraft;
        return snapshot;
      }
      record.updatedAt = now;
      this.appendEvent(record, "draft_saved", now, currentRound(record).draft!.revision);
      this.store.save(record);
      return this.clientSnapshot(reviewId)!;
    });
  }

  async finish(reviewId: string, input: FinishWorkReviewInput = {}): Promise<FinishWorkReviewResult> {
    return this.serialize(reviewId, () => {
      const record = this.store.get(reviewId);
      if (!record) throw new WorkReviewError("not_found", "Work review not found");
      const round = currentRound(record);
      if (round.status === "completed" && round.result) {
        return { review: agentView(record), result: clone(round.result), published: false };
      }
      if (record.archivedAt) throw new WorkReviewError("invalid_state", "Archived work reviews cannot be finished");
      const hasDirectDraft = input.itemDecisions !== undefined
        || input.itemUpdates !== undefined
        || input.overallNote !== undefined
        || input.mutationId !== undefined
        || input.idempotencyKey !== undefined;
      if (input.draft || hasDirectDraft) {
        const finalDraft = input.draft
          ? input.draft
          : {
              mutationId: input.mutationId || input.idempotencyKey,
              expectedRevision: input.expectedDraftRevision ?? input.expectedRevision,
              itemDecisions: input.itemDecisions ?? input.itemUpdates,
              overallNote: input.overallNote,
            };
        // Finish treats the supplied decisions as a complete replacement and
        // writes no intermediate draft record.
        this.applyDraftUpdate(record, {
          ...finalDraft,
          itemDecisions: finalDraft.itemDecisions ?? finalDraft.itemUpdates,
          itemUpdates: undefined,
        }, new Date().toISOString());
      }
      const activeDraft = round.draft;
      if (!activeDraft) throw new WorkReviewError("invalid_state", "Work review has no active draft");
      if (
        !hasDirectDraft
        && !input.draft
        && input.expectedDraftRevision !== undefined
        && input.expectedDraftRevision !== activeDraft.revision
      ) {
        throw new WorkReviewError("revision_conflict", "Work review draft has changed");
      }
      const pending = activeDraft.itemDecisions.filter((decision) => decision.status === "pending");
      if (pending.length > 0) {
        throw new WorkReviewError("invalid_state", "Every work review item needs a decision before finishing");
      }
      const now = new Date().toISOString();
      const result: WorkReviewPublishedResult = {
        resultId: crypto.randomUUID(),
        reviewId: record.reviewId,
        roundId: round.roundId,
        revision: round.revision,
        publishedAt: now,
        draftRevision: activeDraft.revision,
        itemResults: activeDraft.itemDecisions.map((decision) => ({
          itemId: decision.itemId,
          status: decision.status as Exclude<WorkReviewItemStatus, "pending">,
          ...(decision.note ? { note: decision.note } : {}),
        })),
        ...(activeDraft.overallNote ? { overallNote: activeDraft.overallNote } : {}),
      };
      round.status = "completed";
      round.result = result;
      delete round.draft;
      record.updatedAt = now;
      this.appendEvent(record, "finished", now, result.draftRevision);
      const saved = this.store.save(record);
      return { review: agentView(saved), result: clone(result), published: true };
    });
  }

  async newRound(
    reviewId: string,
    input: CreateWorkReviewRoundInput,
  ): Promise<WorkReviewAgentView> {
    return this.serialize(reviewId, () => {
      const record = this.store.get(reviewId);
      if (!record) throw new WorkReviewError("not_found", "Work review not found");
      if (record.archivedAt) throw new WorkReviewError("invalid_state", "Archived work reviews cannot add rounds");
      const content = cleanRoundContent(input);
      const idempotencyKey = boundedString(input.idempotencyKey, "Idempotency key", 300, true)!;
      const idempotencyKeyHash = hash({ originSessionId: record.originSessionId, idempotencyKey });
      const contentHash = hash({ reviewId, ...content });
      const existing = record.rounds.find((round) => round.idempotencyKeyHash === idempotencyKeyHash);
      if (existing) {
        if (existing.contentHash !== contentHash) {
          throw new WorkReviewError(
            "idempotency_conflict",
            "Idempotency key was already used for different work review round content",
          );
        }
        return agentView(record);
      }
      if (currentRound(record).status !== "completed") {
        throw new WorkReviewError("invalid_state", "Finish the current work review round before adding another");
      }
      const now = new Date().toISOString();
      const revision = record.currentRevision + 1;
      record.rounds.push({
        roundId: crypto.randomUUID(),
        revision,
        ...content,
        createdAt: now,
        status: "in_review",
        idempotencyKeyHash,
        contentHash,
        draft: initialDraft(content.items, now),
      });
      record.currentRevision = revision;
      record.updatedAt = now;
      this.appendEvent(record, "new_round", now, 0);
      return agentView(this.store.save(record));
    });
  }

  async archive(reviewId: string): Promise<WorkReviewAgentView> {
    return this.serialize(reviewId, () => {
      const record = this.store.get(reviewId);
      if (!record) throw new WorkReviewError("not_found", "Work review not found");
      if (!record.archivedAt) {
        const now = new Date().toISOString();
        record.archivedAt = now;
        record.updatedAt = now;
        this.appendEvent(record, "archived", now);
        this.store.save(record);
      }
      return agentView(record);
    });
  }

  export(filter: WorkReviewListFilter = {}): WorkReviewExport {
    const reviews = this.store.list()
      .filter((record) =>
        (!filter.originSessionId || record.originSessionId === filter.originSessionId)
        && (filter.includeArchived || !record.archivedAt),
      )
      .map(agentView);
    return { schemaVersion: WORK_REVIEW_SCHEMA_VERSION, exportedAt: new Date().toISOString(), reviews };
  }
}

const workReviewService = new WorkReviewService();

export function createWorkReview(input: CreateWorkReviewInput): Promise<WorkReviewAgentView> {
  return workReviewService.create(input);
}

export function getWorkReview(reviewId: string): WorkReviewAgentView | undefined {
  return workReviewService.get(reviewId);
}

export function listWorkReviews(filter?: WorkReviewListFilter): WorkReviewAgentSummary[] {
  return workReviewService.list(filter);
}

export function getWorkReviewClientSnapshot(reviewId: string): WorkReviewClientSnapshot | undefined {
  return workReviewService.clientSnapshot(reviewId);
}

export function updateWorkReviewDraft(
  reviewId: string,
  input: UpdateWorkReviewDraftInput,
): Promise<WorkReviewClientSnapshot> {
  return workReviewService.updateDraft(reviewId, input);
}

export function finishWorkReview(
  reviewId: string,
  input?: FinishWorkReviewInput,
): Promise<FinishWorkReviewResult> {
  return workReviewService.finish(reviewId, input);
}

export function createWorkReviewRound(
  reviewId: string,
  input: CreateWorkReviewRoundInput,
): Promise<WorkReviewAgentView> {
  return workReviewService.newRound(reviewId, input);
}

export function archiveWorkReview(reviewId: string): Promise<WorkReviewAgentView> {
  return workReviewService.archive(reviewId);
}

export function exportWorkReviews(filter?: WorkReviewListFilter): WorkReviewExport {
  return workReviewService.export(filter);
}

export * from "./work-review-types";
