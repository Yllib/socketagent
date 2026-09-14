export type CodexSubagentStatus =
  | "pending" | "running" | "completed" | "interrupted" | "errored" | "shutdown" | "unavailable";

export function normalizeCodexSubagentStatus(value: unknown): CodexSubagentStatus | null {
  switch (value) {
    case "pending": case "pendingInit": return "pending";
    case "active": case "running": return "running";
    case "idle": case "completed": return "completed";
    case "interrupted": return "interrupted";
    case "errored": case "systemError": case "failed": return "errored";
    case "shutdown": return "shutdown";
    case "notLoaded": case "notFound": case "unavailable": return "unavailable";
    default: return null;
  }
}

export function codexSubagentIsActive(status: CodexSubagentStatus): boolean {
  return status === "pending" || status === "running";
}
