import { createInteractiveRequestId } from "./interactive-request-id";
import { waitForInteractiveAnswer, type PendingInteractiveAnswer } from "./interactive-answer";
import { markQuestionAnswered } from "./session-store";

/** Always asks the connected user, independent of the agent's permission mode. */
export async function requestTranscriptAccess(
  ctx: {
    sessionId: string;
    pendingQuestions: Map<string, PendingInteractiveAnswer>;
    send(message: any): void;
    appendHistory(entry: any): void;
  },
  detail: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.sessionId || signal?.aborted) return false;
  const questionId = createInteractiveRequestId("transcript_access");
  const question = "The agent would like to access historical transcripts from all sessions on this server, including cleared-context archives.\n\n"
    + detail + "\n\nAllow this request only? Later searches and reads require approval again.";
  const message = {
    type: "question", questionId, sessionId: ctx.sessionId,
    questions: [{ question, header: "Transcript access", multiSelect: false,
      options: [{ label: "Allow once" }, { label: "Deny" }] }],
  };
  ctx.appendHistory({ role: "question", content: "", questionId,
    questions: message.questions, timestamp: new Date().toISOString() });
  const waiting = waitForInteractiveAnswer(ctx.pendingQuestions, questionId, message, signal, () => {
    markQuestionAnswered(ctx.sessionId, questionId, {});
    ctx.send({ type: "question_answered", questionId, sessionId: ctx.sessionId, answers: {} });
  });
  ctx.send(message);
  const answers = await waiting;
  return answers?.[question] === "Allow once";
}
