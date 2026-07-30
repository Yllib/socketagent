/**
 * Deliver one published result using the stable result ID as the backend and
 * transcript message identity. The caller is responsible for exact-session
 * lookup; this helper deliberately accepts the already-selected session.
 */
export async function deliverWorkReviewToSession(
  session: any,
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
    await session.runQueryWithOptions(text, originSessionId, {
      messageId: resultId,
    });
    return;
  }
  await session.runQuery(text, originSessionId, resultId);
}

export function buildWorkReviewResultPrompt(
  review: Record<string, any>,
  result: Record<string, any>,
): string {
  const currentRound = Array.isArray(review.rounds)
    ? review.rounds.find((round: any) => String(round.roundId || "") === String(result.roundId || ""))
    : undefined;
  const itemsById = new Map(
    (Array.isArray(currentRound?.items) ? currentRound.items : [])
      .map((item: any) => [String(item.itemId || ""), item]),
  );
  const itemResults = (Array.isArray(result.itemResults) ? result.itemResults : [])
    .map((itemResult: any) => {
      const item = itemsById.get(String(itemResult.itemId || "")) as any;
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
