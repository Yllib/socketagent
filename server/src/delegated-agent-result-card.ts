import type { DelegatedAgentRecord, DelegatedAgentRun } from "./delegated-agent-types";
import type { HistoryEntry } from "./protocol";

export const DELEGATED_AGENT_RESULT_TOOL = "DelegatedAgentResult";

export function delegatedAgentResultToolUseId(
  record: Pick<DelegatedAgentRecord, "delegationId">,
  run: Pick<DelegatedAgentRun, "runId">,
): string {
  return `delegated-agent-result:${record.delegationId}:${run.runId}`;
}

export function delegatedAgentResultHistoryEntries(
  record: DelegatedAgentRecord,
  run: DelegatedAgentRun,
): { call: HistoryEntry; result: HistoryEntry } {
  const toolUseId = delegatedAgentResultToolUseId(record, run);
  const timestamp = run.completedAt || new Date().toISOString();
  const output = run.status === "completed"
    ? run.result || "The delegated turn completed without a final text response."
    : run.error || `The delegated turn ${run.status}.`;
  const input = {
    description: record.label,
    prompt: run.promptPreview,
    subagent_type: record.backend,
    _task_status: run.status,
    _delegated_response: true,
    delegation_id: record.delegationId,
    delegation_run_id: run.runId,
    run_number: run.runNumber,
    child_session_id: record.childSessionId || "",
  };

  return {
    call: {
      role: "tool_call",
      content: record.label,
      toolName: DELEGATED_AGENT_RESULT_TOOL,
      toolInput: input,
      toolUseId,
      timestamp,
      entryId: `${toolUseId}:call`,
    },
    result: {
      role: "tool_result",
      content: output,
      toolName: DELEGATED_AGENT_RESULT_TOOL,
      toolUseId,
      toolOutput: output,
      timestamp,
      entryId: `${toolUseId}:result`,
    },
  };
}
