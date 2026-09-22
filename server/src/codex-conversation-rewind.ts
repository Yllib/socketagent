import type { HistoryEntry } from "./protocol";
import { archiveHistorySnapshot, getHistory, replaceHistory } from "./session-store";

const rewinding = new Set<string>();
export function isCodexRewinding(sessionId: string): boolean { return rewinding.has(sessionId); }

export function codexRewindTarget(thread: any, target: HistoryEntry): { numTurns: number; turnIndex: number } {
  if (thread?.status?.type === "active") throw new Error("Stop the running Codex turn before rewinding");
  if (!Array.isArray(thread?.turns)) throw new Error("Codex did not return the conversation turns");
  const candidates: Array<{ turnIndex: number; promptIndex: number; item: any }> = [];
  thread.turns.forEach((turn: any, turnIndex: number) => {
    (turn.items || []).filter((item: any) => item.type === "userMessage")
      .forEach((item: any, promptIndex: number) => candidates.push({ turnIndex, promptIndex, item }));
  });
  let matches = candidates.filter(({ item }) => target.uuid && (item.clientId === target.uuid || item.id === target.uuid));
  // Older imported transcripts may lack client IDs. Accept only a unique exact
  // prompt without a conflicting client ID. Never estimate from displayed rows.
  if (!matches.length) matches = candidates.filter(({ item }) => !item.clientId
    && (item.content || []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").trim() === target.content.trim());
  if (matches.length !== 1) throw new Error("This message cannot be matched uniquely to a Codex turn");
  const match = matches[0];
  if (match.promptIndex !== 0) throw new Error("This message was sent during an existing turn. Rewind from that turn's first prompt instead");
  return { turnIndex: match.turnIndex, numTurns: thread.turns.length - match.turnIndex };
}

export async function rewindCodexConversation(client: {
  resumeThread(params: any): Promise<unknown>;
  readThread(params: any): Promise<unknown>;
  rollbackThread(threadId: string, numTurns: number): Promise<unknown>;
  revertThread(threadId: string, beforeTurnId: string): Promise<unknown>;
  listThreadTurns(params: any): Promise<unknown>;
}, sessionId: string, cwd: string, uuid: string, dryRun = false) {
  if (rewinding.has(sessionId)) throw new Error("A rewind is already in progress");
  rewinding.add(sessionId);
  try {
    const resumed = await client.resumeThread({ threadId: sessionId, cwd }) as any;
    const response = await client.readThread({ threadId: sessionId, includeTurns: true }) as any;
    const history = getHistory(sessionId);
    const index = history.findIndex(entry => entry.role === "user" && entry.uuid === uuid);
    if (index < 0) throw new Error("The selected prompt is no longer in this conversation");
    const target = codexRewindTarget(response?.thread, history[index]);
    if (!dryRun) {
      archiveHistorySnapshot(sessionId);
      let turns: any[];
      if ((resumed?.thread?.historyMode || response?.thread?.historyMode) === "paginated") {
        await client.revertThread(sessionId, response.thread.turns[target.turnIndex].id);
        // Revert returns metadata only. Verify the retained IDs using the
        // native paginated history, never treat its empty turns field as empty history.
        turns = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.listThreadTurns({ threadId: sessionId, cursor,
            limit: 100, sortDirection: "asc", itemsView: "notLoaded" }) as any;
          if (!Array.isArray(page?.data)) throw new Error("Codex did not return retained turns after rewind");
          turns.push(...page.data);
          cursor = page.nextCursor || undefined;
          if (cursor && cursors.has(cursor)) throw new Error("Codex repeated a turn-history cursor after rewind");
          if (cursor) cursors.add(cursor);
        } while (cursor && turns.length <= target.turnIndex);
      } else {
        const rolledBack = await client.rollbackThread(sessionId, target.numTurns) as any;
        turns = rolledBack?.thread?.turns;
      }
      if (!Array.isArray(turns) || turns.length !== target.turnIndex
          || turns.some((turn: any, i: number) => turn.id !== response.thread.turns[i].id)) {
        throw new Error("Codex returned an unexpected rollback result. Reconnect to check the native conversation before trying again");
      }
      replaceHistory(sessionId, history.slice(0, index));
    }
    return { numTurns: target.numTurns, messagesRemoved: history.length - index, rewindIncludesTarget: true };
  } finally {
    rewinding.delete(sessionId);
  }
}
