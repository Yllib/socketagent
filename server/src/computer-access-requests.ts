import * as crypto from "crypto";
import type {
  ComputerAccessAnswerMessage,
  ComputerAccessRequestCard,
  ComputerAccessRequestServerMessage,
  ComputerAccessResolvedServerMessage,
  HistoryEntry,
} from "./protocol";

export const COMPUTER_ACCESS_REQUEST_TTL_MS = 10 * 60 * 1000;

export type ComputerAccessDecision = ComputerAccessResolvedServerMessage["decision"];

export interface ComputerAccessAnswer {
  decision: ComputerAccessDecision;
  approval?: ComputerAccessAnswerMessage["approval"];
}

interface PendingRequest {
  sessionId: string;
  card: ComputerAccessRequestCard;
  resolve: (answer: ComputerAccessAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export interface ComputerAccessRequestHost {
  /** Broadcast to every device so the card appears and later clears. */
  broadcast(message: ComputerAccessRequestServerMessage | ComputerAccessResolvedServerMessage): void;
  appendHistory(sessionId: string, entry: HistoryEntry): HistoryEntry;
  markResolved(sessionId: string, requestId: string, decision: ComputerAccessDecision): void;
}

/**
 * Cards that ask the user, in the source chat, to approve a remote action or
 * to link a computer. The card is persisted so it reappears when the chat is
 * reopened, and every device hears when it is answered or expires.
 */
export class ComputerAccessRequests {
  private pending = new Map<string, PendingRequest>();

  constructor(private readonly host: ComputerAccessRequestHost) {}

  /** Shows the card and waits for the answer, expiry or the turn's abort. */
  ask(
    sessionId: string,
    card: Omit<ComputerAccessRequestCard, "requestId" | "expiresAt"> & { expiresAt?: number },
    signal?: AbortSignal,
  ): Promise<ComputerAccessAnswer> {
    const requestId = `computer_access_${crypto.randomUUID()}`;
    const expiresAt = Math.min(card.expiresAt ?? Number.MAX_SAFE_INTEGER, Date.now() + COMPUTER_ACCESS_REQUEST_TTL_MS);
    const full: ComputerAccessRequestCard = { ...card, requestId, expiresAt };
    const positioned = this.host.appendHistory(sessionId, {
      role: "computer_access",
      content: card.summary || card.reason || "",
      questionId: requestId,
      computerAccess: full,
      timestamp: new Date().toISOString(),
    });
    this.host.broadcast({
      type: "computer_access_request",
      sessionId,
      ...full,
      ...(positioned.entryId ? { entryId: positioned.entryId } : {}),
      ...(positioned.sessionSeq ? { sessionSeq: positioned.sessionSeq } : {}),
      ...(positioned.revision ? { revision: positioned.revision } : {}),
      ...(positioned.timestamp ? { timestamp: positioned.timestamp } : {}),
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, { decision: "expired" }), Math.max(0, expiresAt - Date.now()));
      timer.unref?.();
      const entry: PendingRequest = { sessionId, card: full, resolve, timer, signal };
      if (signal) {
        entry.onAbort = () => this.settle(requestId, { decision: "expired" });
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(requestId, entry);
      if (signal?.aborted) this.settle(requestId, { decision: "expired" });
    });
  }

  /** The app answered. Returns false when nothing was waiting. */
  answer(message: ComputerAccessAnswerMessage): boolean {
    if (!this.pending.has(message.requestId)) return false;
    this.settle(message.requestId, { decision: message.decision, approval: message.approval });
    return true;
  }

  private settle(requestId: string, answer: ComputerAccessAnswer): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (entry.onAbort) entry.signal?.removeEventListener("abort", entry.onAbort);
    this.host.markResolved(entry.sessionId, requestId, answer.decision);
    this.host.broadcast({ type: "computer_access_resolved", requestId, sessionId: entry.sessionId, decision: answer.decision });
    entry.resolve(answer);
  }

  /** Cards still waiting for an answer, for reconnecting devices. */
  openCards(): ComputerAccessRequestServerMessage[] {
    return Array.from(this.pending.values()).map((entry) => ({
      type: "computer_access_request",
      sessionId: entry.sessionId,
      ...entry.card,
    }));
  }
}
