import type { CodexSession, Session } from "./codex-session";
import type { WorkReviewAgentView, WorkReviewPublishedResult } from "./work-review-types";

/**
 * Deliver one published result using the stable result ID as the backend and
 * transcript message identity. The caller is responsible for exact-session
 * lookup; this helper deliberately accepts the already-selected session.
 */
type WorkReviewDeliverySession = Pick<Session, "injectMessage" | "runQuery">
  & Partial<Pick<CodexSession, "runQueryWithOptions">>;

export async function deliverWorkReviewToSession(
  session: WorkReviewDeliverySession,
  backend: "claude" | "codex",
  text: string,
  originSessionId: string,
  resultId: string,
  busy: boolean,
): Promise<void> {
  if (busy) {
    await session.injectMessage(text, "next", resultId);
    return;
  }
  if (backend === "codex") {
    if (typeof session.runQueryWithOptions !== "function") throw new Error("Work Review backend does not match its session");
    await session.runQueryWithOptions(text, originSessionId, {
      messageId: resultId,
    });
    return;
  }
  await session.runQuery(text, originSessionId, resultId);
}

export function buildWorkReviewResultPrompt(
  review: WorkReviewAgentView,
  result: WorkReviewPublishedResult,
): string {
  const currentRound = review.rounds.find(round => round.roundId === result.roundId);
  const itemsById = new Map(
    (currentRound?.items ?? []).map(item => [item.itemId, item]),
  );
  const itemResults = result.itemResults.map(itemResult => {
      const item = itemsById.get(itemResult.itemId);
      return {
        ...itemResult,
        ...(item?.title ? { title: item.title } : {}),
        ...(item?.primaryTarget ? {
          primaryTarget: {
            kind: item.primaryTarget.kind,
            uri: item.primaryTarget.uri,
            ...(item.primaryTarget.label ? { label: item.primaryTarget.label } : {}),
            ...(item.primaryTarget.environment
              ? { environment: item.primaryTarget.environment }
              : {}),
          },
        } : {}),
      };
    });
  const published = {
    resultId: result.resultId,
    reviewId: result.reviewId,
    roundId: result.roundId,
    revision: result.revision,
    publishedAt: result.publishedAt,
    title: currentRound?.title,
    purpose: currentRound?.purpose,
    summary: currentRound?.summary,
    approvalMeaning: currentRound?.approvalMeaning,
    itemResults,
    ...(result.overallNote ? { overallNote: result.overallNote } : {}),
  };
  return [
    "The user finished the Work Review. This is the single consolidated published result; no draft feedback was sent before Finish Review.",
    `<work-review-result result-id="${String(result.resultId || "")}">`,
    JSON.stringify(published, null, 2),
    "</work-review-result>",
    "Treat resultId as the durable event identity and do not process the same result twice if it is replayed.",
  ].join("\n\n");
}
