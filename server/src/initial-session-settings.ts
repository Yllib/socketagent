import type { Session } from "./codex-session";
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
const CLAUDE_EFFORTS = new Set<AgentEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function thinkingSetting(value: unknown): AgentThinkingSetting | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
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
  session: Session,
  backend: Backend,
  rawSettings: unknown,
): Promise<InitialSessionSettings> {
  const raw = record(rawSettings);
  if (!raw) return {};

  const applied: InitialSessionSettings = {};
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (model && model.length <= 500) {
    await session.setModel(model);
    applied.model = model;
  }

  const effort = typeof raw.effort === "string" ? raw.effort as AgentEffort : undefined;
  const allowedEfforts = backend === "claude" ? CLAUDE_EFFORTS : ALL_EFFORTS;
  if (effort && allowedEfforts.has(effort)) {
    session.setEffort(effort as any);
    applied.effort = effort;
  }

  if (backend === "claude") {
    const thinking = thinkingSetting(raw.thinking);
    if (thinking) {
      session.setThinking(thinking);
      applied.thinking = thinking;
    }
    if (typeof raw.claudeAutoCompact === "boolean") {
      (session as any).setClaudeAutoCompact?.(raw.claudeAutoCompact);
      applied.claudeAutoCompact = raw.claudeAutoCompact;
    }
    const autoCompactWindow = Number(raw.claudeAutoCompactWindow);
    if (
      Number.isSafeInteger(autoCompactWindow)
      && autoCompactWindow >= 100_000
      && autoCompactWindow <= 1_000_000
    ) {
      (session as any).setClaudeAutoCompactWindow?.(autoCompactWindow);
      applied.claudeAutoCompactWindow = autoCompactWindow;
    }
  } else {
    if (typeof raw.codexFastMode === "boolean") {
      (session as any).setCodexFastMode?.(raw.codexFastMode);
      applied.codexFastMode = raw.codexFastMode;
    }
    const collaborationMode = typeof raw.codexCollaborationMode === "string"
      ? raw.codexCollaborationMode.trim()
      : "";
    if (collaborationMode && collaborationMode.length <= 100) {
      (session as any).setCodexCollaborationMode?.(collaborationMode);
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
    await (session as any).setPermissionMode(permissionMode);
    applied.permissionMode = permissionMode;
  }

  return applied;
}
