import type { AgentEffort, AgentSessionSettings, Backend } from "./protocol";

export type DelegatedAgentAction = "start" | "message" | "status" | "list" | "stop";
export type DelegatedAgentStatus = "starting" | "running" | "completed" | "failed" | "stopped";
export type DelegatedAgentReportStatus = "pending" | "delivering" | "delivered";

export interface AgentSessionToolArgs {
  action: DelegatedAgentAction;
  prompt?: string;
  session_id?: string;
  delegation_id?: string;
  backend?: Backend;
  cwd?: string;
  label?: string;
  model?: string;
  effort?: AgentEffort;
  permissionMode?: string;
}

export interface DelegatedAgentRun {
  runId: string;
  runNumber: number;
  promptPreview: string;
  startedAt: string;
  status: DelegatedAgentStatus;
  completedAt?: string;
  result?: string;
  error?: string;
  reportStatus?: DelegatedAgentReportStatus;
  reportAttempts?: number;
  reportDeliveredAt?: string;
}

export interface DelegatedAgentRecord {
  delegationId: string;
  supervisorSessionId: string;
  childSessionId?: string;
  backend: Backend;
  cwd: string;
  label: string;
  status: DelegatedAgentStatus;
  createdAt: string;
  updatedAt: string;
  permissionMode?: string;
  agentSettings?: AgentSessionSettings;
  runs: DelegatedAgentRun[];
}

export interface AgentSessionToolResponse {
  action: DelegatedAgentAction;
  delegation?: DelegatedAgentRecord;
  delegations?: DelegatedAgentRecord[];
  message?: string;
}

export type AgentSessionToolExecutor = (
  args: AgentSessionToolArgs,
) => Promise<AgentSessionToolResponse>;
