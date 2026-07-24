// ── Backend selection ──

/**
 * Which agent backend drives the session. "claude" uses the Claude Agent SDK
 * (subscription auth via the Claude Code CLI). "codex" uses the OpenAI Codex
 * CLI (subscription auth via ChatGPT Plus/Pro). Defaults to "claude" when
 * omitted for backward compatibility with existing sessions.
 */
export type Backend = "claude" | "codex";

export type CodexDriver = "app-server";

// ── Client → Server messages ──

export interface PromptMessage {
  type: "prompt";
  text: string;
  sessionId?: string;
  cwd?: string;
  codexFastMode?: boolean;
}

export interface RetractQueuedPromptMessage {
  type: "retract_queued_prompt";
  messageId: string;
}

export interface AnswerMessage {
  type: "answer";
  questionId: string;
  answers: Record<string, string>;
}

export interface SecureInputResponseMessage {
  type: "secure_input_response";
  requestId: string;
  value?: string;
  secretId?: string;
  sessionId?: string;
  cancelled?: boolean;
}

export interface SecureInputStoreMessage {
  type: "secure_input_store";
  label: string;
  value: string;
  reason?: string;
  envHint?: string;
  scope?: "session" | "project" | "global";
  sessionId?: string;
  cwd?: string;
  clientRequestId?: string;
}

export interface SecretInventoryRequestMessage {
  type: "secret_inventory_request";
  requestId?: string;
  sessionId?: string;
  cwd?: string;
}

export interface SecretReplaceMessage {
  type: "secret_replace";
  requestId: string;
  secretId: string;
  value: string;
  label?: string;
  envHint?: string;
  sessionId?: string;
  cwd?: string;
}

export interface SecretDeleteMessage {
  type: "secret_delete";
  requestId: string;
  secretId: string;
  sessionId?: string;
  cwd?: string;
}

export interface HtmlPlanListMessage {
  type: "html_plan_list";
  requestId?: string;
  sessionId: string;
}

export interface HtmlPlanRenameMessage {
  type: "html_plan_rename";
  requestId: string;
  sessionId: string;
  planId: string;
  title: string;
}

export interface HtmlPlanDeleteMessage {
  type: "html_plan_delete";
  requestId: string;
  sessionId: string;
  planId: string;
}

export interface HtmlPlanRevisionListMessage {
  type: "html_plan_revision_list";
  requestId: string;
  sessionId: string;
  planId: string;
}

export interface HtmlPlanRevisionGetMessage {
  type: "html_plan_revision_get";
  requestId: string;
  sessionId: string;
  planId: string;
  revision: number;
  baseRevision?: number;
}

export interface HtmlPlanRollbackMessage {
  type: "html_plan_rollback";
  requestId: string;
  sessionId: string;
  planId: string;
  revision: number;
}

export interface NewSessionMessage {
  type: "new_session";
  cwd?: string;
  /** Which agent backend to use. Defaults to "claude" if omitted. */
  backend?: Backend;
}

export interface ResumeSessionMessage {
  type: "resume_session";
  sessionId: string;
  /** Correlates the initial history snapshot with the view that requested it. */
  historyRequestId?: string;
  /** Last durable transcript position already cached by this client. */
  knownSessionSeq?: number;
  /** Oldest history offset represented by the client's cached snapshot. */
  knownHistoryOffset?: number;
  /** Number of contiguous durable entries represented by the cached snapshot. */
  knownHistoryEntryCount?: number;
  /** Optional client trace identifier for click-to-ready diagnostics. */
  openTraceId?: string;
}

export interface SessionEventAckMessage {
  type: "session_event_ack";
  sessionId: string;
  deliveryId: string;
}

export interface ClientEventErrorMessage {
  type: "client_event_error";
  sessionId?: string;
  eventType?: string;
  deliveryId?: string;
  toolUseId?: string;
  message: string;
}

export interface ListSessionsMessage {
  type: "list_sessions";
}

export interface GetServerSettingsMessage {
  type: "get_server_settings";
}

export interface SetCodexDriverMessage {
  type: "set_codex_driver";
  driver: CodexDriver;
}

export interface SetServerSettingsMessage {
  type: "set_server_settings";
  defaultCwd?: string;
  systemPrompt?: string;
  /** Migration helper: seed the server only when it has no prompt yet. */
  systemPromptIfUnset?: string;
}

export interface BackendInstallMessage {
  type: "backend_install";
  backend: Backend;
  reinstall?: boolean;
  authenticate?: boolean;
  forceAuthenticate?: boolean;
  operation?: "repair" | "auth";
  requestId?: string;
}

export interface BackendInstallCancelMessage {
  type: "backend_install_cancel";
  backend: Backend;
  requestId?: string;
}

export interface DeleteSessionMessage {
  type: "delete_session";
  sessionId: string;
}

export interface RenameSessionMessage {
  type: "rename_session";
  sessionId: string;
  title: string;
}

export interface AbortMessage {
  type: "abort";
  sessionId?: string;
  /** Stable id reused until the client receives abort_ack. */
  requestId?: string;
}

export interface InterruptMessage {
  type: "interrupt";
}

export interface SetTtsMessage {
  type: "set_tts";
  enabled: boolean;
}

export interface SetTtsEngineMessage {
  type: "set_tts_engine";
  engine: "system" | "kokoro_server" | "kokoro_device";
  voice?: string;
  speed?: number;
}

export interface RequestTtsAudioMessage {
  type: "request_tts_audio";
  text: string;
  voice?: string;
  speed?: number;
}

export interface RequestFileMessage {
  type: "request_file";
  filePath: string;
  fileId?: string;
  offsetBytes?: number;
  transferToken?: string;
  expectedFileVersion?: string;
}

export interface LoadMoreHistoryMessage {
  type: "load_more_history";
  sessionId: string;
  offset: number;
  limit: number;
  /** Correlates an older-history page with the pagination request. */
  requestId?: string;
}

export interface CheckCwdMessage {
  type: "check_cwd";
  path: string;
  requestId?: string;
}

export interface CreateCwdMessage {
  type: "create_cwd";
  path: string;
  requestId?: string;
}

export interface FileManagerListMessage {
  type: "file_manager_list";
  requestId?: string;
  path?: string;
  includeHidden?: boolean;
}

export interface MacosPermissionStatusMessage {
  type: "macos_permission_status";
  requestId?: string;
  path?: string;
}

export interface MacosPermissionActionMessage {
  type: "macos_permission_action";
  requestId?: string;
  action: "open_settings" | "reveal_helper" | "restart";
}

export interface FileManagerSetProtectedMessage {
  type: "file_manager_set_protected";
  requestId?: string;
  path: string;
  protected: boolean;
  label?: string;
  pattern?: "exact" | "directory";
}

export interface FileManagerDownloadMessage {
  type: "file_manager_download";
  requestId?: string;
  path: string;
  fileId?: string;
  offsetBytes?: number;
  transferToken?: string;
  expectedFileVersion?: string;
}

export interface FileManagerReadTextMessage {
  type: "file_manager_read_text";
  requestId?: string;
  path: string;
  maxBytes?: number;
}

export interface FileManagerWriteTextMessage {
  type: "file_manager_write_text";
  requestId?: string;
  path: string;
  content: string;
}

export interface FileManagerMkdirMessage {
  type: "file_manager_mkdir";
  requestId?: string;
  path: string;
}

export interface FileManagerRenameMessage {
  type: "file_manager_rename";
  requestId?: string;
  fromPath: string;
  toName: string;
}

export interface FileManagerDeleteMessage {
  type: "file_manager_delete";
  requestId?: string;
  path: string;
  recursive?: boolean;
}

export interface FileManagerUploadStartMessage {
  type: "file_manager_upload_start";
  requestId?: string;
  uploadId: string;
  targetDir: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunkSize: number;
  conflictPolicy?: "fail" | "rename" | "overwrite";
}

export interface ClearContextMessage {
  type: "clear_context";
  sessionId: string;
}

export interface CompactContextMessage {
  type: "compact_context";
  sessionId?: string;
}

export interface CodexRollbackThreadMessage {
  type: "codex_rollback_thread";
  sessionId?: string;
  numTurns: number;
}

export interface CodexCollaborationModesMessage {
  type: "codex_collaboration_modes";
}

export interface SetCodexCollaborationModeMessage {
  type: "set_codex_collaboration_mode";
  mode: string;
}

export interface ArchiveSessionMessage {
  type: "archive_session";
  sessionId: string;
}

export interface ListArchivesMessage {
  type: "list_archives";
}

export interface GetArchiveHistoryMessage {
  type: "get_archive_history";
  sid: string;
  ts: string;
}

export interface RestoreArchiveMessage {
  type: "restore_archive";
  sid: string;
  ts: string;
}

export interface DeleteArchiveMessage {
  type: "delete_archive";
  sid: string;
  ts: string;
}

export interface UploadStartMessage {
  type: "upload_start";
  uploadId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
}

export interface UploadChunkMessage {
  type: "upload_chunk";
  uploadId: string;
  chunkIndex: number;
  data: string;
}

/** Binary-frame variant of upload_chunk — `data` is raw bytes, no base64 inflation. */
export interface UploadChunkBinMessage {
  type: "upload_chunk_bin";
  uploadId: string;
  chunkIndex: number;
  data: Buffer;
}

/** Phone announces its wire-format support after key exchange. */
export interface ClientCapabilitiesMessage {
  type: "client_capabilities";
  binaryEnvelope?: boolean;
  binaryFileDownloadVersion?: number;
  /**
   * Version 1 means the client acknowledges only after its live reducer has
   * applied a tracked session event. Do not infer this from the legacy boolean:
   * app v1.0.114 advertised that flag before it implemented acknowledgements.
   */
  sessionEventAckVersion?: number;
  /** @deprecated Ambiguous compatibility flag; never enables tracked delivery. */
  sessionEventAck?: boolean;
}

export interface SetRawModeMessage {
  type: "set_raw_mode";
  enabled: boolean;
  sessionId?: string;
}

/** Direct E2E auth token proof, sent only after the NaCl key exchange. */
export interface DirectAuthMessage {
  type: "direct_auth";
  token: string;
  binaryEnvelope?: boolean;
  binaryFileDownloadVersion?: number;
  sessionEventAckVersion?: number;
  /** @deprecated Ambiguous compatibility flag; never enables tracked delivery. */
  sessionEventAck?: boolean;
}

export const SESSION_EVENT_ACK_VERSION = 1;

export function supportsSessionEventAcknowledgement(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const version = (message as Record<string, unknown>).sessionEventAckVersion;
  return typeof version === "number"
    && Number.isInteger(version)
    && version >= SESSION_EVENT_ACK_VERSION;
}

export interface FileDownloadAckMessage {
  type: "file_download_ack";
  fileId: string;
  transferToken?: string;
  receivedBytes: number;
}

export interface TerminalAttachMessage {
  type: "terminal_attach";
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalInputMessage {
  type: "terminal_input";
  data: string;
}

export interface TerminalResizeMessage {
  type: "terminal_resize";
  cols: number;
  rows: number;
}

export interface TerminalDetachMessage {
  type: "terminal_detach";
}

export interface TerminalKillMessage {
  type: "terminal_kill";
}

export interface AdbBridgeSidecarStartMessage {
  type: "adb_bridge_sidecar_start";
  requestId?: string;
  localPort?: number;
}

export interface AdbBridgeSidecarStopMessage {
  type: "adb_bridge_sidecar_stop";
  requestId?: string;
}

export interface AdbBridgeSidecarStatusMessage {
  type: "adb_bridge_sidecar_status";
  requestId?: string;
}

export interface AdbCommandMessage {
  type: "adb_command";
  requestId?: string;
  command: "pair" | "connect";
  host: string;
  port: number;
  code?: string;
}

export interface PhoneAdbResultMessage {
  type: "phone_adb_result";
  requestId: string;
  result: Record<string, unknown>;
}

export interface PhoneAdbStreamChunkMessage {
  type: "phone_adb_stream_chunk";
  requestId: string;
  stream: "stdout" | "stderr" | string;
  data: string;
}

export interface RegisterPushTokenMessage {
  type: "register_push_token";
  fcmToken: string;
  platform?: string;
  appServerId?: string;
}

export interface UnregisterPushTokenMessage {
  type: "unregister_push_token";
  fcmToken: string;
  appServerId?: string;
}

export interface GetPushRegistrationMessage {
  type: "get_push_registration";
  fcmToken: string;
  appServerId?: string;
}

export interface SetEffortMessage {
  type: "set_effort";
  effort: "minimal" | "low" | "medium" | "high" | "max" | "xhigh" | "ultra";
}

export interface SetCodexFastModeMessage {
  type: "set_codex_fast_mode";
  enabled: boolean;
}

export interface SetClaudeAutoCompactMessage {
  type: "set_claude_auto_compact";
  enabled: boolean;
}

export interface SetThinkingMessage {
  type: "set_thinking";
  thinking:
    | { type: "adaptive" }
    | { type: "enabled"; budgetTokens: number }
    | { type: "disabled" };
}

export interface SetDisallowedToolsMessage {
  type: "set_disallowed_tools";
  tools: string[];
  sessionId?: string;
}

export interface SetSystemPromptMessage {
  type: "set_system_prompt";
  prompt: string;
  sessionId?: string;
  /** Apply the server default without storing it as a session override. */
  inherited?: boolean;
  /** Remove a previously persisted session override. */
  clearOverride?: boolean;
}

export type AgentEffort = "minimal" | "low" | "medium" | "high" | "max" | "xhigh" | "ultra";

export type AgentThinkingSetting =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens: number }
  | { type: "disabled" };

export interface AgentSessionSettings {
  model?: string;
  effort?: AgentEffort;
  thinking?: AgentThinkingSetting;
  codexFastMode?: boolean;
  codexCollaborationMode?: string;
  claudeAutoCompact?: boolean;
  disallowedTools?: string[];
  systemPrompt?: string;
}

export interface StopTaskMessage {
  type: "stop_task";
  taskId: string;
}

export interface StopMonitorMessage {
  type: "stop_monitor";
  taskId: string;
}

export interface ForkSessionMessage {
  type: "fork_session";
  sessionId: string;
}

export interface SetModelMessage {
  type: "set_model";
  model?: string;
}

export interface SetPermissionModeMessage {
  type: "set_permission_mode";
  mode: string;
}

export interface McpStatusRequestMessage {
  type: "mcp_status";
}

export interface GetContextUsageMessage {
  type: "get_context_usage";
}

export interface GetSdkEventHistoryMessage {
  type: "get_sdk_event_history";
  sessionId?: string;
  limit?: number;
}

export interface McpReconnectMessage {
  type: "mcp_reconnect";
  serverName: string;
}

export interface McpToggleMessage {
  type: "mcp_toggle";
  serverName: string;
  enabled: boolean;
}

export interface RewindMessage {
  type: "rewind";
  userMessageUuid: string;
  dryRun?: boolean;
}

export interface RewindConversationMessage {
  type: "rewind_conversation";
  userMessageUuid: string;
  dryRun?: boolean;
  rewindFiles?: boolean; // default true — set false to rewind conversation only, leaving files as-is
}

export interface BranchFromMessage {
  type: "branch_from_message";
  sessionId: string;
  userMessageUuid: string;
}

export interface SyncDesktopMessage {
  type: "sync_desktop";
  sessionId: string;
}

export interface ListSdkSessionsMessage {
  type: "list_sdk_sessions";
  cwd: string;
  requestId?: string;
  limit?: number;
}

export interface ScheduleTaskMessage {
  type: "schedule_task";
  name?: string;
  prompt: string;
  cwd: string;
  backend?: Backend;
  codexDriver?: CodexDriver;
  model?: string;
  effort?: AgentEffort;
  permissionMode?: string;
  scheduledTime: string;
  recurrence?: {
    type: "once" | "daily" | "weekly" | "monthly" | "custom";
    intervalMs?: number;
  };
  reuseSession?: boolean;
  notificationMode?: "completion" | "quiet";
}

export interface ListScheduledTasksMessage {
  type: "list_scheduled_tasks";
}

export interface CancelScheduledTaskMessage {
  type: "cancel_scheduled_task";
  taskId: string;
}

export interface ExecuteScheduledTaskMessage {
  type: "execute_scheduled_task";
  taskId: string;
}

export interface UpdateScheduledTaskMessage {
  type: "update_scheduled_task";
  taskId: string;
  name?: string;
  prompt?: string;
  cwd?: string;
  backend?: Backend;
  codexDriver?: CodexDriver | null;
  model?: string | null;
  effort?: AgentEffort;
  permissionMode?: string;
  scheduledTime?: string;
  recurrence?: { type: "once" | "daily" | "weekly" | "monthly" | "custom"; intervalMs?: number } | null;
  reuseSession?: boolean;
  notificationMode?: "completion" | "quiet";
}

export interface DeleteScheduledTaskMessage {
  type: "delete_scheduled_task";
  taskId: string;
}

export type ClientMessage =
  | PromptMessage
  | RetractQueuedPromptMessage
  | AnswerMessage
  | SecureInputResponseMessage
  | SecureInputStoreMessage
  | SecretInventoryRequestMessage
  | SecretReplaceMessage
  | SecretDeleteMessage
  | HtmlPlanListMessage
  | HtmlPlanRenameMessage
  | HtmlPlanDeleteMessage
  | HtmlPlanRevisionListMessage
  | HtmlPlanRevisionGetMessage
  | HtmlPlanRollbackMessage
  | NewSessionMessage
  | ResumeSessionMessage
  | SessionEventAckMessage
  | ClientEventErrorMessage
  | ListSessionsMessage
  | GetServerSettingsMessage
  | SetCodexDriverMessage
  | SetServerSettingsMessage
  | BackendInstallMessage
  | BackendInstallCancelMessage
  | CodexCollaborationModesMessage
  | SetCodexCollaborationModeMessage
  | DeleteSessionMessage
  | RenameSessionMessage
  | ClearContextMessage
  | CompactContextMessage
  | CodexRollbackThreadMessage
  | ArchiveSessionMessage
  | AbortMessage
  | InterruptMessage
  | SetTtsMessage
  | SetTtsEngineMessage
  | RequestTtsAudioMessage
  | SetEffortMessage
  | SetCodexFastModeMessage
  | SetClaudeAutoCompactMessage
  | SetThinkingMessage
  | SetDisallowedToolsMessage
  | SetSystemPromptMessage
  | StopTaskMessage
  | StopMonitorMessage
  | ForkSessionMessage
  | SetModelMessage
  | SetPermissionModeMessage
  | McpStatusRequestMessage
  | GetContextUsageMessage
  | GetSdkEventHistoryMessage
  | McpReconnectMessage
  | McpToggleMessage
  | RewindMessage
  | RewindConversationMessage
  | BranchFromMessage
  | SyncDesktopMessage
  | ListSdkSessionsMessage
  | RequestFileMessage
  | LoadMoreHistoryMessage
  | CheckCwdMessage
  | CreateCwdMessage
  | FileManagerListMessage
  | MacosPermissionStatusMessage
  | MacosPermissionActionMessage
  | FileManagerSetProtectedMessage
  | FileManagerDownloadMessage
  | FileManagerReadTextMessage
  | FileManagerWriteTextMessage
  | FileManagerMkdirMessage
  | FileManagerRenameMessage
  | FileManagerDeleteMessage
  | FileManagerUploadStartMessage
  | UploadStartMessage
  | UploadChunkMessage
  | UploadChunkBinMessage
  | FileDownloadAckMessage
  | ClientCapabilitiesMessage
  | SetRawModeMessage
  | DirectAuthMessage
  | TerminalAttachMessage
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalDetachMessage
  | TerminalKillMessage
  | AdbBridgeSidecarStartMessage
  | AdbBridgeSidecarStopMessage
  | AdbBridgeSidecarStatusMessage
  | AdbCommandMessage
  | PhoneAdbResultMessage
  | PhoneAdbStreamChunkMessage
  | RegisterPushTokenMessage
  | UnregisterPushTokenMessage
  | GetPushRegistrationMessage
  | ScheduleTaskMessage
  | ListScheduledTasksMessage
  | CancelScheduledTaskMessage
  | ExecuteScheduledTaskMessage
  | UpdateScheduledTaskMessage
  | DeleteScheduledTaskMessage
  | ListArchivesMessage
  | GetArchiveHistoryMessage
  | RestoreArchiveMessage
  | DeleteArchiveMessage
  | { type: "auth_code"; code: string; sessionId?: string; authRequestId?: string }
  | { type: "version_check" }
  | { type: "force_update" }
  | { type: "get_status_sync" }
  | { type: "get_codex_status" }
  | { type: "get_recent_cwds" }
  | { type: "add_recent_cwd"; cwd: string }
  | { type: "remove_recent_cwd"; cwd: string }
  | { type: "skills_list" }
  | { type: "codex_slash_command"; name: string; args?: string; sessionId?: string }
  | { type: "skills_save"; name: string; scope: string; format: string; agent?: "claude" | "codex"; frontmatter: Record<string, string>; body: string; filePath?: string }
  | { type: "skills_delete"; filePath: string }
  | { type: "protected_files_list"; requestId?: string }
  | { type: "protected_files_add"; requestId?: string; path: string; label?: string }
  | { type: "protected_files_delete"; requestId?: string; path: string }
  | { type: "plugins_list" }
  | { type: "plugins_install"; pluginId: string }
  | { type: "plugins_uninstall"; pluginId: string }
  | { type: "plugins_enable"; pluginId: string }
  | { type: "plugins_disable"; pluginId: string }
  | { type: "marketplaces_list" }
  | { type: "marketplaces_add"; url: string }
  | { type: "marketplaces_update"; name: string }
  | { type: "marketplaces_remove"; name: string };

// ── Server → Client messages ──

export interface TextServerMessage {
  type: "text";
  content: string;
  sessionId: string;
  streamId?: string;
  parentToolUseId?: string | null;
  uuid?: string;
  replay?: boolean;
  snapshot?: boolean;
  finalSnapshot?: boolean;
  deliveryId?: string;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

export interface ToolCallServerMessage {
  type: "tool_call";
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
  parentToolUseId?: string | null;
  uuid?: string;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

export interface ToolResultServerMessage {
  type: "tool_result";
  toolUseId: string;
  output: string;
  sessionId: string;
  parentToolUseId?: string | null;
  uuid?: string;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

export interface ToolImageServerMessage {
  type: "tool_image";
  toolUseId: string;
  imageData: string;
  mimeType: string;
  filePath: string;
  sessionId: string;
  parentToolUseId?: string | null;
}

export interface EmailPreview {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  attachment?: string;
  scheduledTime?: string;
}

export interface QuestionServerMessage {
  type: "question";
  questionId: string;
  questions: QuestionItem[];
  sessionId: string;
  emailPreview?: EmailPreview;
  mcpServerName?: string;
}

export interface SecureInputRequestServerMessage {
  type: "secure_input_request";
  requestId: string;
  sessionId: string;
  label: string;
  reason?: string;
  envHint?: string;
  scope?: "session" | "project" | "global";
  multiline?: boolean;
}

export interface SecureInputSavedServerMessage {
  type: "secure_input_saved";
  requestId?: string;
  sessionId?: string;
  secretId: string;
  label: string;
  scope: "session" | "project" | "global";
  filePath: string;
  envHint: string;
  clientRequestId?: string;
}

export interface SecretInventoryEntry {
  secretId: string;
  label: string;
  scope: "session" | "project" | "global";
  filePath: string;
  envHint: string;
  createdAt: string;
  updatedAt?: string;
}

export interface SecretInventoryServerMessage {
  type: "secret_inventory";
  requestId?: string;
  sessionId?: string;
  secrets: SecretInventoryEntry[];
}

export interface SecretOperationResultServerMessage {
  type: "secret_operation_result";
  requestId: string;
  operation: "create" | "replace" | "delete";
  ok: boolean;
  error?: string;
  secret?: SecretInventoryEntry;
}

export interface HtmlPlanRecord {
  planId: string;
  sessionId: string;
  title: string;
  html: string;
  createdAt: string;
  updatedAt: string;
  currentRevision: number;
  revisionCount: number;
}

export interface HtmlPlanRevisionSummaryRecord {
  revision: number;
  title: string;
  createdAt: string;
  byteSize: number;
  restoredFromRevision?: number;
}

export interface HtmlPlanRevisionRecord {
  revision: number;
  title: string;
  html: string;
  createdAt: string;
  restoredFromRevision?: number;
}

export interface HtmlPlanDiffSegmentRecord {
  type: "equal" | "added" | "removed";
  text: string;
}

export interface HtmlPlanServerMessage extends HtmlPlanRecord {
  type: "html_plan";
  deliveryId?: string;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

export interface HtmlPlanListServerMessage {
  type: "html_plan_list";
  requestId?: string;
  sessionId: string;
  plans: HtmlPlanRecord[];
}

export interface HtmlPlanOperationResultServerMessage {
  type: "html_plan_operation_result";
  requestId: string;
  operation: "rename" | "delete" | "rollback";
  ok: boolean;
  sessionId: string;
  planId: string;
  error?: string;
  plan?: HtmlPlanRecord;
}

export interface HtmlPlanRevisionListServerMessage {
  type: "html_plan_revision_list";
  requestId: string;
  sessionId: string;
  planId: string;
  ok: boolean;
  error?: string;
  revisions: HtmlPlanRevisionSummaryRecord[];
}

export interface HtmlPlanRevisionServerMessage {
  type: "html_plan_revision";
  requestId: string;
  sessionId: string;
  planId: string;
  ok: boolean;
  error?: string;
  revision?: HtmlPlanRevisionRecord;
  baseRevision?: number;
  diff: HtmlPlanDiffSegmentRecord[];
}

export interface QuestionItem {
  question: string;
  header?: string;
  options: { label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
}

export interface ThinkingServerMessage {
  type: "thinking";
  content: string;
  sessionId: string;
  streamId?: string;
  parentToolUseId?: string | null;
  uuid?: string;
  replay?: boolean;
  snapshot?: boolean;
  finalSnapshot?: boolean;
  deliveryId?: string;
  entryId?: string;
  sessionSeq?: number;
  revision?: number;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  contextWindow: number;
}

export interface TotalUsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
}

export interface ResultServerMessage {
  type: "result";
  content: string;
  sessionId: string;
  costUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  usage?: UsageInfo;
  totalUsage?: TotalUsageInfo;
  numTurns?: number;
  stopReason?: string;
  resultSubtype?: string;
  terminalReason?: string;
  fastModeState?: string;
  errors?: string[];
  permissionDenials?: { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }[];
}

export interface SessionListServerMessage {
  type: "session_list";
  sessions: SessionInfo[];
}

export interface SdkSessionListServerMessage {
  type: "sdk_session_list";
  cwd: string;
  requestId?: string;
  total: number;
  hasMore: boolean;
  sessions: Array<{
    sessionId: string;
    firstMessage: string;
    lastActive: string;
    backend?: Backend;
  }>;
}

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  lastActive: string;
  messagePreview: string;
  /** Number of user turns/prompts in this session when known. */
  turnCount?: number;
  /** Number of SocketAgent history entries when known. */
  historyCount?: number;
  running?: boolean;
  /** Server-owned ISO timestamp for the current active turn/compaction. */
  activeStartedAt?: string;
  lastUsage?: UsageInfo & { costUsd?: number; numTurns?: number };
  scheduledTaskId?: string;
  /** Backend that drives this session. Absent on legacy sessions = "claude". */
  backend?: Backend;
  /** Codex runtime driver for codex sessions. Absent means use the server default. */
  codexDriver?: CodexDriver;
  /** Last selected permission mode for this session. */
  permissionMode?: string;
  /** Agent controls persisted for this session and restored on every resume. */
  agentSettings?: AgentSessionSettings;
  /** Set after clear-context until the next fresh backend session replaces this id. */
  contextClearedAt?: string;
}

export interface ErrorServerMessage {
  type: "error";
  message: string;
}

export interface BackendAuthRequiredServerMessage {
  type: "backend_auth_required";
  backend: Backend;
  message: string;
  detail?: string;
  sessionId?: string;
}

export interface PushTokenRegisteredServerMessage {
  type: "push_token_registered";
  appServerId?: string;
}

export interface PushTokenUnregisteredServerMessage {
  type: "push_token_unregistered";
  appServerId?: string;
}

export interface PushRegistrationStatusServerMessage {
  type: "push_registration_status";
  appServerId?: string;
  registered: boolean;
}

export interface ServerCapabilitiesMessage {
  type: "server_capabilities";
  binaryEnvelope?: boolean;
  binaryFileDownloadVersion?: number;
  secretManagement?: {
    version: number;
  };
  htmlPlans?: {
    version: number;
  };
  /** Backends supported by this server build. Health/auth state is in backendHealth. */
  backends: Backend[];
  codexDriver?: CodexDriver;
  codexDriversAvailable?: CodexDriver[];
  backendHealth?: BackendHealthInfo[];
  directE2e?: {
    serverPubkey: string;
  };
  relayPairing?: {
    relayUrl: string;
    pairingToken: string;
    serverPubkey: string;
  };
}

export interface BackendHealthInfo {
  backend: Backend;
  enabled: boolean;
  available: boolean;
  severity: "ok" | "warning" | "error" | "disabled";
  source?: "explicit" | "sdk" | "managed" | "legacy" | "system" | "path" | "unresolved";
  command?: string;
  version?: string;
  reason?: string;
  detail?: string;
  installRoot?: string;
}

export interface ServerSettingsMessage {
  type: "server_settings";
  codexDriver: CodexDriver;
  defaultCwd: string;
  systemPrompt: string;
  systemPromptInitialized?: boolean;
  codexDriversAvailable: CodexDriver[];
  backendHealth?: BackendHealthInfo[];
}

export interface BackendInstallProgressServerMessage {
  type: "backend_install_progress";
  requestId?: string;
  backend: Backend;
  operation?: "repair" | "auth";
  phase: "install" | "auth" | "probe";
  status: "running" | "completed" | "failed" | "cancelled";
  message: string;
  output?: string;
  authUrl?: string;
  authCode?: string;
}

export interface SessionCreatedServerMessage {
  type: "session_created";
  sessionId: string;
  /** Previous session ID when clear-context created this replacement. */
  replacesSessionId?: string;
  cwd: string;
  title?: string;
  /** Echoed back so the client knows which backend the server is using. */
  backend?: Backend;
  permissionMode?: string;
}

export interface SessionArchiveFailedServerMessage {
  type: "session_archive_failed";
  sessionId: string;
  error: string;
}

export interface HistoryEntry {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "tool_image" | "question" | "secure_input" | "html_plan" | "todos_update" | "codex_plan" | "user_uuid" | "elicitation_url" | "prompt_suggestion" | "monitor" | "notification" | "permission_mode";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolOutput?: string;
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  // Server-internal large-output storage. These fields may be present in
  // persisted history; the server hydrates toolOutput before sending to clients.
  toolOutputRef?: string;
  toolOutputBytes?: number;
  toolOutputStoredBytes?: number;
  toolOutputPreview?: string;
  toolOutputEncoding?: "gzip";
  timestamp: string;
  // Question fields (role === "question")
  questionId?: string;
  questions?: QuestionItem[];
  emailPreview?: EmailPreview;
  answered?: boolean;
  // Subagent hierarchy and message tracking
  parentToolUseId?: string | null;
  uuid?: string;
  // Tool summary fields
  toolSummary?: boolean;
  precedingToolUseIds?: string[];
  // Thinking block
  thinking?: boolean;
  // Tool image fields (role === "tool_image")
  filePath?: string;
  mimeType?: string;
  // Elicitation URL fields (role === "elicitation_url")
  mcpServerName?: string;
  url?: string;
  // Monitor fields (role === "monitor")
  taskId?: string;
  description?: string;
  // Notification fields (role === "notification")
  status?: string;
  originToolUseId?: string;
  commandName?: string;
  commandPayload?: Record<string, unknown>;
  // Permission mode fields (role === "permission_mode")
  permissionMode?: string;
  /** Stable transcript identity shared by live delivery and history replay. */
  entryId?: string;
  /** Monotonic position within one SocketAgent session. */
  sessionSeq?: number;
  /** Monotonic content revision for streamed entries. */
  revision?: number;
  /** Stable backend stream identity used to join live frames to history. */
  streamId?: string;
}

export interface SessionHistoryServerMessage {
  type: "session_history";
  sessionId: string;
  messages: HistoryEntry[];
  /** Echoed from resume_session.historyRequestId or load_more_history.requestId. */
  requestId?: string;
  /** Explicit merge behavior; clients must not infer this from local state. */
  historyKind?: "initial" | "delta" | "older" | "append";
  /** Total durable entries currently stored for the session. */
  total?: number;
  /** Zero-based position of the first entry in messages. */
  offset?: number;
  /** True when older context was intentionally deferred from first paint. */
  deferredContextAvailable?: boolean;
  /** Total durable user prompts in the session, used to bound background backfill. */
  totalUserPrompts?: number;
  /** Echoed client trace identifier for click-to-ready diagnostics. */
  openTraceId?: string;
}

export interface StatusServerMessage {
  type: "status";
  sessionId: string;
  running: boolean;
  compacting?: boolean;
  activeStartedAt?: string;
  activeToolUseId?: string;
  permissionMode?: string;
}

export interface AbortAckServerMessage {
  type: "abort_ack";
  requestId: string;
  sessionId: string;
  stopped: boolean;
  alreadyStopped?: boolean;
  error?: string;
}

export interface CompactingServerMessage {
  type: "compacting";
  active: boolean;
  sessionId: string;
}

export interface FileChunkServerMessage {
  type: "file_chunk";
  fileId: string;
  fileName: string;
  fileSize: number;
  offsetBytes?: number;
  transferToken?: string;
  fileVersion?: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
}

export interface FileCompleteServerMessage {
  type: "file_complete";
  fileId: string;
  fileName: string;
  fileSize?: number;
  transferToken?: string;
  fileVersion?: string;
}

export interface FileErrorServerMessage {
  type: "file_error";
  fileId: string;
  message: string;
  transferToken?: string;
}

export interface UploadCompleteServerMessage {
  type: "upload_complete";
  uploadId: string;
  serverPath: string;
}

export interface FileManagerEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size?: number;
  modifiedAt?: string;
  hidden: boolean;
  extension?: string;
  mimeType?: string;
  mediaKind?: "image" | "video" | "audio" | "text" | "archive" | "code" | "other";
  protected: boolean;
  protectedLabel?: string;
}

export interface FileManagerListResultServerMessage {
  type: "file_manager_list_result";
  requestId?: string;
  ok: boolean;
  path: string;
  parentPath?: string;
  entries: FileManagerEntry[];
  roots: Array<{ label: string; path: string }>;
  error?: string;
  errorCode?: string;
  permission?: Record<string, unknown>;
}

export interface MacosPermissionStatusServerMessage {
  type: "macos_permission_status_result";
  requestId?: string;
  supported: boolean;
  platform: NodeJS.Platform;
  access: "granted" | "denied" | "unknown" | "not_applicable";
  path: string;
  helperInstalled: boolean;
  helperActive: boolean;
  helperPath: string;
  settingsPane: string;
  error?: string;
  errorCode?: string;
}

export interface MacosPermissionActionServerMessage {
  type: "macos_permission_action_result";
  requestId?: string;
  ok: boolean;
  action: string;
  helperPath: string;
  restarting?: boolean;
  error?: string;
}

export interface FileManagerProtectedResultServerMessage {
  type: "file_manager_protected_result";
  requestId?: string;
  ok: boolean;
  path: string;
  protected: boolean;
  entry?: { path: string; label?: string };
  removed?: { path: string; label?: string };
  entries?: Array<{ path: string; label?: string }>;
  error?: string;
}

export interface FileManagerOperationResultServerMessage {
  type: "file_manager_operation_result";
  requestId?: string;
  operation: "download" | "mkdir" | "rename" | "delete" | "upload_start" | "write_text";
  ok: boolean;
  path?: string;
  newPath?: string;
  fileId?: string;
  uploadId?: string;
  error?: string;
}

export interface FileManagerTextResultServerMessage {
  type: "file_manager_text_result";
  requestId?: string;
  ok: boolean;
  path: string;
  content?: string;
  truncated?: boolean;
  bytesRead?: number;
  error?: string;
}

export interface ReminderServerMessage {
  type: "reminder";
  title: string;
  body: string;
  scheduledTime: string;
  notificationId: number;
  sessionId: string;
}

export interface CompactBoundaryServerMessage {
  type: "compact_boundary";
  trigger: string;
  preTokens: number;
  sessionId: string;
}

export interface TaskNotificationServerMessage {
  type: "task_notification";
  taskId: string;
  status: "started" | "completed" | "failed" | "stopped";
  outputFile?: string;
  summary: string;
  sessionId: string;
  originToolUseId?: string;
  parentToolUseId?: string | null;
  uuid?: string;
}

export interface CodexCommandResultServerMessage {
  type: "codex_command_result";
  taskId: string;
  command: string;
  status: "completed" | "failed" | "stopped" | string;
  summary: string;
  payload: Record<string, unknown>;
  sessionId: string;
  parentToolUseId?: string | null;
}

export interface ToolSummaryServerMessage {
  type: "tool_summary";
  summary: string;
  precedingToolUseIds: string[];
  sessionId: string;
  parentToolUseId?: string | null;
  uuid?: string;
}

export interface SessionForkedServerMessage {
  type: "session_forked";
  originalSessionId: string;
  newSessionId: string;
  cwd: string;
}

export interface RewindConversationResultServerMessage {
  type: "rewind_conversation_result";
  sessionId: string;
  success: boolean;
  userMessageUuid: string;
  dryRun?: boolean;
  filesReverted?: string[];
  insertions?: number;
  deletions?: number;
  messagesRemoved?: number;
  error?: string;
}

export interface BranchResultServerMessage {
  type: "branch_result";
  success: boolean;
  originalSessionId: string;
  newSessionId?: string;
  branchPointUuid: string;
  cwd?: string;
  error?: string;
}

export interface TtsAudioServerMessage {
  type: "tts_audio";
  audioData: string;
  text: string;
  sessionId: string;
}

export interface ActiveSubagentsServerMessage {
  type: "active_subagents";
  sessionId: string;
  replace?: boolean;
  backend?: Backend;
  tasks: {
    agentId: string;
    toolUseId: string;
    description: string;
    subagentType: string;
    startedAt: string;
    status?: "pending" | "running" | "completed" | "interrupted" | "errored" | "shutdown";
    prompt?: string;
    model?: string;
    reasoningEffort?: string;
    agentPath?: string;
    parentToolUseId?: string | null;
  }[];
}

export interface ScheduledTaskListServerMessage {
  type: "scheduled_task_list";
  tasks: import("./scheduled-task-store").ScheduledTask[];
  revision?: string;
}

export interface ScheduledTaskUpdateServerMessage {
  type: "scheduled_task_update";
  task: import("./scheduled-task-store").ScheduledTask;
}

export interface ScheduledTaskNotificationServerMessage {
  type: "scheduled_task_notification";
  title: string;
  body: string;
  sessionId: string;
  status?: "completed" | "failed" | "manual";
  sessionCompletion?: boolean;
  kind?: string;
  eventId?: string;
  navigationTarget?: "scheduled_tasks";
  scheduledTaskId?: string;
  fcmDispatched?: boolean;
}

// SDK event forwarding messages

export interface RateLimitEventServerMessage {
  type: "rate_limit_event";
  status: string;
  resetsAt?: string;
  utilization?: number;
  rateLimitType?: string;
  sessionId: string;
}

export interface TaskStartedServerMessage {
  type: "task_started";
  taskId: string;
  toolUseId?: string;
  description: string;
  taskType?: string;
  prompt?: string;
  sessionId: string;
}

export interface BgTaskProgressServerMessage {
  type: "bg_task_progress";
  taskId: string;
  toolUseId?: string;
  description?: string;
  usage?: Record<string, unknown>;
  lastToolName?: string;
  summary?: string;
  sessionId: string;
}

export interface ApiRetryServerMessage {
  type: "api_retry";
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorStatus?: number;
  sessionId: string;
}

export interface LocalCommandOutputServerMessage {
  type: "local_command_output";
  content: string;
  sessionId: string;
}

export interface PromptSuggestionServerMessage {
  type: "prompt_suggestion";
  suggestion: string;
  sessionId: string;
}

export interface SessionLifecycleServerMessage {
  type: "session_lifecycle";
  event: "start" | "end";
  source?: string;
  reason?: string;
  model?: string;
  agentType?: string;
  sessionId: string;
}

export interface SessionSettingsServerMessage {
  type: "session_settings";
  sessionId: string;
  settings: AgentSessionSettings;
}

export interface SupportedModelsServerMessage {
  type: "supported_models";
  models: Array<Record<string, unknown>>;
  currentModel?: string;
  sessionId: string;
  backend: Backend;
  cached?: boolean;
  updatedAt?: string;
}

export interface MonitorStartedServerMessage {
  type: "monitor_started";
  taskId: string;
  description: string;
  monitoring: boolean;
  command?: string;
  sessionId: string;
}

export interface MonitorOutputServerMessage {
  type: "monitor_output";
  taskId: string;
  content: string;
  sessionId: string;
}

export interface TaskCompletedHookServerMessage {
  type: "task_completed_hook";
  taskId: string;
  subject: string;
  description?: string;
  teammateName?: string;
  sessionId: string;
}

export interface ElicitationUrlServerMessage {
  type: "elicitation_url";
  questionId: string;
  mcpServerName: string;
  message: string;
  url: string;
  elicitationId?: string;
  sessionId: string;
}

export interface HookStartedServerMessage {
  type: "hook_started";
  hookId: string;
  hookName: string;
  hookEvent: string;
  sessionId: string;
}

export interface HookProgressServerMessage {
  type: "hook_progress";
  hookId: string;
  hookName: string;
  hookEvent: string;
  stdout: string;
  stderr: string;
  sessionId: string;
}

export interface HookResponseServerMessage {
  type: "hook_response";
  hookId: string;
  hookName: string;
  hookEvent: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  outcome: string;
  sessionId: string;
}

export interface UsageUpdateServerMessage {
  type: "usage_update";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  contextWindow: number;
  sessionId: string;
}

export interface TerminalStatusServerMessage {
  type: "terminal_status";
  running: boolean;
  pid?: number;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  exitCode?: number;
}

export interface TerminalOutputServerMessage {
  type: "terminal_output";
  data: string;
  replay?: boolean;
}

export interface TerminalExitedServerMessage {
  type: "terminal_exited";
  exitCode: number;
  signal?: number;
}

export interface TerminalErrorServerMessage {
  type: "terminal_error";
  message: string;
}

export interface PhoneAdbRequestServerMessage {
  type: "phone_adb_request";
  requestId: string;
  command: string;
  shellCommand?: string;
  args?: string[];
  timeoutSeconds?: number;
  maxBytes?: number;
  fileName?: string;
  fileSize?: number;
}

export interface PhoneAdbFileChunkServerMessage {
  type: "phone_adb_file_chunk";
  requestId: string;
  chunkIndex: number;
  data: string;
}

export interface PhoneAdbFileEndServerMessage {
  type: "phone_adb_file_end";
  requestId: string;
  ok: boolean;
  message?: string;
}

export interface PhoneAdbCancelServerMessage {
  type: "phone_adb_cancel";
  requestId: string;
}

export type ServerMessage =
  | TextServerMessage
  | ToolCallServerMessage
  | ToolResultServerMessage
  | QuestionServerMessage
  | SecureInputRequestServerMessage
  | SecureInputSavedServerMessage
  | SecretInventoryServerMessage
  | SecretOperationResultServerMessage
  | HtmlPlanServerMessage
  | HtmlPlanListServerMessage
  | HtmlPlanOperationResultServerMessage
  | HtmlPlanRevisionListServerMessage
  | HtmlPlanRevisionServerMessage
  | ResultServerMessage
  | SessionListServerMessage
  | SdkSessionListServerMessage
  | ErrorServerMessage
  | BackendAuthRequiredServerMessage
  | PushTokenRegisteredServerMessage
  | PushTokenUnregisteredServerMessage
  | PushRegistrationStatusServerMessage
  | ServerCapabilitiesMessage
  | ServerSettingsMessage
  | BackendInstallProgressServerMessage
  | SessionCreatedServerMessage
  | SessionArchiveFailedServerMessage
  | SessionHistoryServerMessage
  | StatusServerMessage
  | AbortAckServerMessage
  | CompactingServerMessage
  | FileChunkServerMessage
  | FileCompleteServerMessage
  | FileErrorServerMessage
  | UploadCompleteServerMessage
  | FileManagerListResultServerMessage
  | MacosPermissionStatusServerMessage
  | MacosPermissionActionServerMessage
  | FileManagerProtectedResultServerMessage
  | FileManagerOperationResultServerMessage
  | FileManagerTextResultServerMessage
  | ReminderServerMessage
  | CompactBoundaryServerMessage
  | TaskNotificationServerMessage
  | CodexCommandResultServerMessage
  | ToolSummaryServerMessage
  | SessionForkedServerMessage
  | RewindConversationResultServerMessage
  | BranchResultServerMessage
  | TtsAudioServerMessage
  | ThinkingServerMessage
  | ToolImageServerMessage
  | ActiveSubagentsServerMessage
  | ScheduledTaskListServerMessage
  | ScheduledTaskUpdateServerMessage
  | ScheduledTaskNotificationServerMessage
  | RateLimitEventServerMessage
  | TaskStartedServerMessage
  | BgTaskProgressServerMessage
  | ApiRetryServerMessage
  | LocalCommandOutputServerMessage
  | PromptSuggestionServerMessage
  | SessionLifecycleServerMessage
  | SessionSettingsServerMessage
  | SupportedModelsServerMessage
  | TaskCompletedHookServerMessage
  | ElicitationUrlServerMessage
  | UsageUpdateServerMessage
  | HookStartedServerMessage
  | HookProgressServerMessage
  | HookResponseServerMessage
  | MonitorStartedServerMessage
  | MonitorOutputServerMessage
  | TerminalStatusServerMessage
  | TerminalOutputServerMessage
  | TerminalExitedServerMessage
  | TerminalErrorServerMessage
  | PhoneAdbRequestServerMessage
  | PhoneAdbFileChunkServerMessage
  | PhoneAdbFileEndServerMessage
  | PhoneAdbCancelServerMessage;
