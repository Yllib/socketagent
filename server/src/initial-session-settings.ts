import type { CodexSession } from "./codex-session";
import type { ClaudeSession } from "./claude-session";
import { isRecord } from "./value-guards";
import type {
  AgentEffort,
  AgentThinkingSetting,
  Backend,
  InitialSessionSettings,
} from "./protocol";

const ALL_EFFORTS = new Set<AgentEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
  "ultra",
]);
export function isClaudeEffort(value: unknown): value is Parameters<ClaudeSession["setEffort"]>[0] {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
const CLAUDE_PERMISSION_MODES = new Set([
  "plan",
  "default",
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "superYolo",
]);
const CODEX_PERMISSION_MODES = new Set([
  "plan",
  "default",
  "bypassPermissions",
  "superYolo",
]);

type CommonSettingsMethod = "setModel" | "setEffort" | "setThinking" | "setPermissionMode";
export type InitialSettingsSession =
  | Pick<ClaudeSession, CommonSettingsMethod | "setClaudeAutoCompact" | "setClaudeAutoCompactWindow">
  | Pick<CodexSession, CommonSettingsMethod | "setCodexFastMode" | "setCodexCollaborationMode">;

function thinkingSetting(value: unknown): AgentThinkingSetting | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value;
  if (candidate.type === "adaptive" || candidate.type === "disabled") {
    return { type: candidate.type };
  }
  if (candidate.type !== "enabled") return undefined;
  const budgetTokens = Number(candidate.budgetTokens);
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) return undefined;
  return { type: "enabled", budgetTokens };
}

/**
 * Applies settings carried with the first prompt. Runtime validation is
 * intentional: WebSocket clients are untrusted even though the app is typed.
 */
export async function applyInitialSessionSettings(
  session: InitialSettingsSession,
  backend: Backend,
  rawSettings: unknown,
): Promise<InitialSessionSettings> {
  if (!isRecord(rawSettings)) return {};
  const raw = rawSettings;

  const applied: InitialSessionSettings = {};
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (model && model.length <= 500) {
    await session.setModel(model);
    applied.model = model;
  }

  const effort = typeof raw.effort === "string" ? raw.effort : undefined;
  if (isClaudeEffort(effort)) {
    session.setEffort(effort);
    applied.effort = effort;
  } else if (backend === "codex" && effort && ALL_EFFORTS.has(effort) && "setCodexFastMode" in session) {
    session.setEffort(effort);
    applied.effort = effort;
  }

  if (backend === "claude") {
    const thinking = thinkingSetting(raw.thinking);
    if (thinking) {
      session.setThinking(thinking);
      applied.thinking = thinking;
    }
    if (typeof raw.claudeAutoCompact === "boolean" && "setClaudeAutoCompact" in session) {
      session.setClaudeAutoCompact(raw.claudeAutoCompact);
      applied.claudeAutoCompact = raw.claudeAutoCompact;
    }
    const autoCompactWindow = Number(raw.claudeAutoCompactWindow);
    if (
      Number.isSafeInteger(autoCompactWindow)
      && autoCompactWindow >= 100_000
      && autoCompactWindow <= 1_000_000
      && "setClaudeAutoCompactWindow" in session
    ) {
      session.setClaudeAutoCompactWindow(autoCompactWindow);
      applied.claudeAutoCompactWindow = autoCompactWindow;
    }
  } else {
    if (typeof raw.codexFastMode === "boolean" && "setCodexFastMode" in session) {
      session.setCodexFastMode(raw.codexFastMode);
      applied.codexFastMode = raw.codexFastMode;
    }
    const collaborationMode = typeof raw.codexCollaborationMode === "string"
      ? raw.codexCollaborationMode.trim()
      : "";
    if (collaborationMode && collaborationMode.length <= 100 && "setCodexCollaborationMode" in session) {
      session.setCodexCollaborationMode(collaborationMode);
      applied.codexCollaborationMode = collaborationMode;
    }
  }

  const permissionMode = typeof raw.permissionMode === "string"
    ? raw.permissionMode.trim()
    : "";
  const allowedPermissionModes = backend === "claude"
    ? CLAUDE_PERMISSION_MODES
    : CODEX_PERMISSION_MODES;
  if (permissionMode && allowedPermissionModes.has(permissionMode)) {
    const effectiveMode = backend === "claude" && permissionMode === "superYolo" ? "bypassPermissions" : permissionMode;
    await session.setPermissionMode(effectiveMode);
    applied.permissionMode = effectiveMode;
  }

  return applied;
}
