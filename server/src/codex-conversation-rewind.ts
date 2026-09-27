import type { HistoryEntry } from "./protocol";
import { CodexAppServerProtocolError, type CodexAppServerClient } from "./codex-app-server-client";
import { parseRewindThread, parseRewindResponse, parseRewindPage, parseRewindUserMessage, readRewindHistoryMode } from "./codex-rewind-contract";
import { invalidateCodexInstructions } from "./codex-instruction-delivery";
import { archiveHistorySnapshot, getConversationRewindBoundary, truncateConversationHistory } from "./session-store";

const rewinding = new Set<string>();
export function isCodexRewinding(sessionId: string): boolean { return rewinding.has(sessionId); }

/** Keep wire-protocol dumps in server logs, not in the chat error banner. */
export function codexRewindErrorMessage(error: unknown): string {
  if (error instanceof CodexAppServerProtocolError) {
    if (error.unsupportedMethod) return "This Codex version does not support the requested rewind. Update Codex and try again";
    if (error.detail.length <= 400) return error.detail;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 400 ? message : "Codex could not complete the rewind. Check the server log for details";
}

export function codexRewindTarget(value: unknown, target: Pick<HistoryEntry, "uuid" | "content">): { numTurns: number; turnIndex: number } {
  const thread = parseRewindThread(value);
  const candidates: Array<{ turnIndex: number; promptIndex: number; item: NonNullable<ReturnType<typeof parseRewindUserMessage>> }> = [];
  thread.turns.forEach((turn, turnIndex) => {
    let promptIndex = 0;
    for (const value of turn.items ?? []) {
      const item = parseRewindUserMessage(value);
      if (item) candidates.push({ turnIndex, promptIndex: promptIndex++, item });
    }
  });
  let matches = candidates.filter(({ item }) => target.uuid && (item.clientId === target.uuid || item.id === target.uuid));
  // Older imported transcripts may lack client IDs. Accept only a unique exact
  // prompt without a conflicting client ID. Never estimate from displayed rows.
  if (!matches.length) matches = candidates.filter(({ item }) => !item.clientId
    && item.text === target.content.trim());
  if (matches.length !== 1) throw new Error("This message cannot be matched uniquely to a Codex turn");
  const match = matches[0];
  if (match.promptIndex !== 0) throw new Error("This message was sent during an existing turn. Rewind from that turn's first prompt instead");
  return { turnIndex: match.turnIndex, numTurns: thread.turns.length - match.turnIndex };
}

export async function rewindCodexConversation(client: Pick<CodexAppServerClient,
  "resumeThread" | "readThread" | "rollbackThread" | "revertThread" | "listThreadTurns"
>, sessionId: string, cwd: string, uuid: string, dryRun = false) {
  if (rewinding.has(sessionId)) throw new Error("A rewind is already in progress");
  rewinding.add(sessionId);
  try {
    const resumed = await client.resumeThread({ threadId: sessionId, cwd });
    const thread = parseRewindResponse(await client.readThread({ threadId: sessionId, includeTurns: true }));
    const boundary = getConversationRewindBoundary(sessionId, uuid);
    const target = codexRewindTarget(thread, boundary.entry);
    let messagesRemoved = boundary.messagesRemoved;
    if (!dryRun) {
      await archiveHistorySnapshot(sessionId);
      let turns: Array<{ id: string }>;
      if ((readRewindHistoryMode(resumed) || thread.historyMode) === "paginated") {
        await client.revertThread(sessionId, thread.turns[target.turnIndex].id);
        invalidateCodexInstructions(sessionId);
        // Revert returns metadata only. Verify the retained IDs using the
        // native paginated history, never treat its empty turns field as empty history.
        turns = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = parseRewindPage(await client.listThreadTurns({ threadId: sessionId, cursor,
            limit: 100, sortDirection: "asc", itemsView: "notLoaded" }));
          turns.push(...page.data);
          cursor = page.nextCursor || undefined;
          if (cursor && cursors.has(cursor)) throw new Error("Codex repeated a turn-history cursor after rewind");
          if (cursor) cursors.add(cursor);
        } while (cursor && turns.length <= target.turnIndex);
      } else {
        const rolledBack = await client.rollbackThread(sessionId, target.numTurns);
        invalidateCodexInstructions(sessionId);
        turns = parseRewindResponse(rolledBack).turns;
      }
      if (!Array.isArray(turns) || turns.length !== target.turnIndex
          || turns.some((turn, i) => turn.id !== thread.turns[i].id)) {
        throw new Error("Codex returned an unexpected rollback result. Reconnect to check the native conversation before trying again");
      }
      messagesRemoved = truncateConversationHistory(sessionId, boundary.entry);
    }
    return { numTurns: target.numTurns, messagesRemoved, rewindIncludesTarget: true };
  } finally {
    rewinding.delete(sessionId);
  }
}
