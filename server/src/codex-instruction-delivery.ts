import { createHash } from "crypto";
import { getSession, saveSession } from "./session-store";

/** Resume settings do not rewrite an existing thread's model-visible history.
 * Deliver changed guidance explicitly, and acknowledge it only after Codex
 * accepts the developer message. Persist the digest to avoid appending the
 * whole integration prompt again on every turn or server restart.
 */
export async function deliverCodexInstructions(
  client: { injectDeveloperInstructions(threadId: string, text: string): Promise<unknown> },
  threadId: string,
  instructions: string,
  startedNewThread: boolean,
): Promise<void> {
  const digest = createHash("sha256").update(instructions).digest("hex");
  const previous = getSession(threadId)?.codexInstructionDelivery;
  if (previous?.threadId === threadId && previous.digest === digest) return;
  if (!startedNewThread) {
    await client.injectDeveloperInstructions(threadId,
      "<socketagent_integration_instructions>\n"
      + "These are the current SocketAgent integration instructions. They replace any older version of this integration guidance.\n\n"
      + instructions + "\n</socketagent_integration_instructions>");
  }
  const session = getSession(threadId);
  if (session) saveSession({ ...session, codexInstructionDelivery: { threadId, digest } });
}

export function invalidateCodexInstructions(threadId: string): void {
  const session = getSession(threadId);
  if (session?.codexInstructionDelivery) {
    delete session.codexInstructionDelivery;
    saveSession(session);
  }
}
