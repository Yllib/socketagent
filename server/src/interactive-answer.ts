import type { ServerMessage } from "./protocol";

/** Shared lifecycle for SDK callbacks that wait for a phone response. */
export interface PendingInteractiveAnswer {
  questionId: string;
  questionData?: ServerMessage;
  resolve: (answers: Record<string, string>) => void;
  cancel?: () => void;
  /** Date.now() when the card opened. Plugins can add cards without it. */
  openedAt?: number;
}

/** When the oldest card in [pending] opened, or undefined when none is open. */
export function oldestOpenedAt(pending: Map<string, { openedAt?: number }>): number | undefined {
  let oldest: number | undefined;
  for (const { openedAt } of pending.values()) {
    if (openedAt !== undefined && (oldest === undefined || openedAt < oldest)) oldest = openedAt;
  }
  return oldest;
}

export function waitForInteractiveAnswer(
  pending: Map<string, PendingInteractiveAnswer>,
  questionId: string,
  questionData: ServerMessage,
  signal: AbortSignal | undefined,
  onCancel: () => void,
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answers: Record<string, string> | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      pending.delete(questionId);
      if (answers === null) onCancel();
      resolve(answers);
    };
    const cancel = () => finish(null);
    pending.set(questionId, { questionId, questionData, resolve: finish, cancel, openedAt: Date.now() });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
