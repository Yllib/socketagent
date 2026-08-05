import { AnswerResult } from "./plugin-api";

export interface PluginAnswerAcknowledgement {
  [key: string]: unknown;
  type: "question_answered";
  questionId: string;
  sessionId?: string;
  answers?: Record<string, string>;
}

/**
 * Build the app acknowledgement for a plugin-consumed answer. The submitted
 * payload is intentionally unavailable to this function: plugin answers may
 * contain cookies or tokens, so only an explicit sanitized projection can be
 * returned to the client or persisted as ordinary question history.
 */
export function createPluginAnswerAcknowledgement(
  questionId: string,
  sessionId: string | undefined,
  result: Extract<AnswerResult, { handled: true }>,
): PluginAnswerAcknowledgement {
  return {
    type: "question_answered",
    questionId,
    ...(sessionId ? { sessionId } : {}),
    ...(result.publicAnswers
      ? { answers: { ...result.publicAnswers } }
      : {}),
  };
}
