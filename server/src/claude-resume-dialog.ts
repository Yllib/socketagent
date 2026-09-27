import type { UserDialogRequest, UserDialogResult } from "@anthropic-ai/claude-agent-sdk";
import type { QuestionItem } from "./protocol";

export const resumeQuestion: QuestionItem = {
  header: "Resume conversation",
  question: "Compact before sending?",
  options: [
    { label: "Compact and continue", description: "Summarize earlier context, then send your message. Some detail may be lost." },
    { label: "Keep full context", description: "Continue with the existing context. Resuming may use more tokens." },
  ],
  multiSelect: false,
};

/** Only advertise dialogs we can answer. Cancelled is safe here only after Stop
 * aborts the query; the CLI may otherwise apply its default and send the prompt. */
export async function handleClaudeResumeDialog(
  request: UserDialogRequest,
  signal: AbortSignal,
  ask: (question: QuestionItem) => Promise<Record<string, string> | null>,
): Promise<UserDialogResult | null> {
  if (request.dialogKind !== "resume_return") return null;
  while (!signal.aborted) {
    const answers = await ask(resumeQuestion);
    if (!answers || signal.aborted) return { behavior: "cancelled" };
    const answer = answers[resumeQuestion.question];
    if (answer === "Compact and continue") return { behavior: "completed", result: "compact" };
    if (answer === "Keep full context") return { behavior: "completed", result: "continue" };
    // Old clients allow free text. Do not guess a destructive choice from it.
  }
  return { behavior: "cancelled" };
}
