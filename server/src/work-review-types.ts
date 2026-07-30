export const WORK_REVIEW_SCHEMA_VERSION = 1;
export const MAX_WORK_REVIEW_ITEMS = 100;
export const MAX_WORK_REVIEW_SUPPORTING_TARGETS = 20;
export const MAX_WORK_REVIEW_TOTAL_BYTES = 2 * 1024 * 1024;

export type WorkReviewTargetKind =
  | "url"
  | "file"
  | "image"
  | "html"
  | "diff"
  | "session"
  | "custom";

export type WorkReviewDisplayMode = "auto" | "embedded" | "external";
export type WorkReviewItemStatus =
  | "pending"
  | "approved"
  | "changes_requested"
  | "rejected"
  | "skipped";
export type WorkReviewDecisionStatus = Exclude<WorkReviewItemStatus, "pending">;
export type WorkReviewRoundStatus = "in_review" | "completed";

export interface WorkReviewTargetInput {
  kind: WorkReviewTargetKind;
  uri: string;
  label?: string;
  environment?: string;
  displayMode?: WorkReviewDisplayMode;
  description?: string;
}

export interface WorkReviewTarget extends WorkReviewTargetInput {
  targetId: string;
  displayMode: WorkReviewDisplayMode;
}

export interface WorkReviewItemInput {
  itemId?: string;
  title: string;
  description?: string;
  instructions?: string;
  primaryTarget: WorkReviewTargetInput;
  supportingTargets?: WorkReviewTargetInput[];
}

export interface WorkReviewItem {
  itemId: string;
  title: string;
  description?: string;
  instructions?: string;
  primaryTarget: WorkReviewTarget;
  supportingTargets: WorkReviewTarget[];
}

export interface WorkReviewRoundContentInput {
  title: string;
  purpose?: string;
  summary?: string;
  instructions?: string;
  approvalMeaning?: string;
  items: WorkReviewItemInput[];
}

export interface CreateWorkReviewInput extends WorkReviewRoundContentInput {
  idempotencyKey: string;
  originSessionId: string;
  originBackend?: string;
}

export interface CreateWorkReviewRoundInput extends WorkReviewRoundContentInput {
  idempotencyKey: string;
}

export interface WorkReviewItemDecision {
  itemId: string;
  status: WorkReviewItemStatus;
  note?: string;
}

export interface WorkReviewDraft {
  revision: number;
  updatedAt: string;
  itemDecisions: WorkReviewItemDecision[];
  overallNote?: string;
}

export interface UpdateWorkReviewDraftItemInput {
  itemId: string;
  status: WorkReviewItemStatus;
  note?: string | null;
}

export interface UpdateWorkReviewDraftInput {
  /** Makes transport retries idempotent when supplied. */
  mutationId?: string;
  expectedRevision?: number;
  itemUpdates?: UpdateWorkReviewDraftItemInput[];
  overallNote?: string | null;
}

export interface FinishWorkReviewInput extends UpdateWorkReviewDraftInput {
  expectedDraftRevision?: number;
  /** Alias used by client Finish messages for mutation deduplication. */
  idempotencyKey?: string;
  /** A complete replacement list when sent directly rather than under draft. */
  itemDecisions?: UpdateWorkReviewDraftItemInput[];
  /**
   * Optional final state sent by the client. It is applied and published by one
   * serialized record replacement; it is never exposed as an intermediate draft.
   */
  draft?: UpdateWorkReviewDraftInput & {
    /** A complete replacement list. Prefer this for Finish Review. */
    itemDecisions?: UpdateWorkReviewDraftItemInput[];
  };
}

export interface WorkReviewPublishedItemResult {
  itemId: string;
  status: WorkReviewDecisionStatus;
  note?: string;
}

export interface WorkReviewPublishedResult {
  resultId: string;
  reviewId: string;
  roundId: string;
  revision: number;
  publishedAt: string;
  draftRevision: number;
  itemResults: WorkReviewPublishedItemResult[];
  overallNote?: string;
}

export interface WorkReviewAgentRoundView {
  roundId: string;
  revision: number;
  title: string;
  purpose?: string;
  summary?: string;
  instructions?: string;
  approvalMeaning?: string;
  items: WorkReviewItem[];
  createdAt: string;
  status: WorkReviewRoundStatus;
  result?: WorkReviewPublishedResult;
}

export interface WorkReviewAgentView {
  reviewId: string;
  cardId: string;
  originSessionId: string;
  originBackend?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  currentRevision: number;
  rounds: WorkReviewAgentRoundView[];
  events: WorkReviewEvent[];
}

export interface WorkReviewClientSnapshot extends WorkReviewAgentView {
  currentDraft?: WorkReviewDraft;
}

export interface WorkReviewAgentSummary {
  reviewId: string;
  cardId: string;
  originSessionId: string;
  originBackend?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  currentRevision: number;
  currentRoundId: string;
  status: WorkReviewRoundStatus;
  itemCount: number;
}

export interface WorkReviewListFilter {
  originSessionId?: string;
  includeArchived?: boolean;
}

export interface FinishWorkReviewResult {
  review: WorkReviewAgentView;
  result: WorkReviewPublishedResult;
  /** True only for the call which durably sealed this round. */
  published: boolean;
}

export interface WorkReviewExport {
  schemaVersion: typeof WORK_REVIEW_SCHEMA_VERSION;
  exportedAt: string;
  reviews: WorkReviewAgentView[];
}

export type WorkReviewEventType =
  | "created"
  | "draft_saved"
  | "finished"
  | "new_round"
  | "archived";

/** Audit event safe for agent-facing reads; draft content is never included. */
export interface WorkReviewEvent {
  eventId: string;
  type: WorkReviewEventType;
  at: string;
  revision: number;
  draftRevision?: number;
}

export class WorkReviewError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "validation"
      | "idempotency_conflict"
      | "revision_conflict"
      | "invalid_state",
    message: string,
  ) {
    super(message);
    this.name = "WorkReviewError";
  }
}

/** Internal persisted shape. Draft is deliberately absent from agent-facing views. */
export interface StoredWorkReviewRound extends WorkReviewAgentRoundView {
  idempotencyKeyHash: string;
  contentHash: string;
  draft?: WorkReviewDraft;
  draftMutations?: Array<{
    mutationIdHash: string;
    contentHash: string;
    resultingRevision: number;
    resultDraft: WorkReviewDraft;
  }>;
}

export interface StoredWorkReviewRecord {
  schemaVersion: typeof WORK_REVIEW_SCHEMA_VERSION;
  reviewId: string;
  cardId: string;
  originSessionId: string;
  originBackend?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  currentRevision: number;
  rounds: StoredWorkReviewRound[];
  events: WorkReviewEvent[];
}
