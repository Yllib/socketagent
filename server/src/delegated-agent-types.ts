import type { AgentEffort, AgentSessionSettings, Backend } from "./protocol";

export type DelegatedAgentAction =
  | "start"
  | "message"
  | "status"
  | "tail"
  | "list"
  | "stop"
  | "answer";
export type DelegatedAgentStatus = "starting" | "running" | "completed" | "failed" | "stopped";
/** `undeliverable` is final: the supervisor session no longer exists. */
export type DelegatedAgentReportStatus = "pending" | "delivering" | "delivered" | "undeliverable";

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
  /** Return durable child activity newer than this transcript sequence. */
  after_session_seq?: number;
  /** Maximum durable activity entries returned by action=tail. */
  limit?: number;
  /** A linked computer's name or public key. With it, the action runs there. */
  computer?: string;
  /** For answer: the child's question ID from the question report. */
  question_id?: string;
  /** For answer: one answer per question, in order. */
  answers?: string[];
}

export interface DelegatedAgentTailEntry {
  session_seq: number;
  entry_id?: string;
  revision?: number;
  timestamp: string;
  type: string;
  content?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  status?: string;
  parent_tool_use_id?: string | null;
}

export interface DelegatedAgentLiveActivity {
  running: boolean;
  assistant_text?: Array<{
    stream_id: string;
    content: string;
    parent_tool_use_id?: string;
  }>;
  active_tools?: Array<{
    tool_use_id: string;
    tool: string;
    input?: Record<string, unknown>;
    parent_tool_use_id?: string;
  }>;
  reasoning?: {
    in_progress: boolean;
    estimated_tokens?: number;
  };
}

export interface DelegatedAgentTail {
  session_id: string;
  status: DelegatedAgentStatus;
  entries: DelegatedAgentTailEntry[];
  after_session_seq: number | null;
  next_session_seq: number;
  latest_session_seq: number;
  has_more: boolean;
  live?: DelegatedAgentLiveActivity;
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
  /**
   * Immediate session that invoked AgentSession action=start. This is display
   * lineage only; supervisorSessionId remains the authorization namespace.
   */
  parentSessionId?: string;
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
  /** Source side: the child runs on this linked computer; runs mirror its reports. */
  remoteComputer?: { publicKey: string; name: string };
  /** Target side: the supervisor is a chat on another computer, reached over the link lane. */
  remoteSupervisor?: { publicKey: string; name: string; sourceSessionId: string };
}

export interface AgentSessionToolResponse {
  action: DelegatedAgentAction;
  delegation?: DelegatedAgentRecord;
  delegations?: DelegatedAgentRecord[];
  tail?: DelegatedAgentTail;
  message?: string;
}

export type AgentSessionToolExecutor = (
  args: AgentSessionToolArgs,
) => Promise<AgentSessionToolResponse>;
