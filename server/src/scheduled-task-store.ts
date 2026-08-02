import * as fs from "fs";
import * as path from "path";
import type { AgentEffort, Backend, CodexDriver } from "./protocol";
import { socketAgentDataPath } from "./socket-agent-paths";

const STORE_DIR = socketAgentDataPath();
const TASKS_FILE = path.join(STORE_DIR, "scheduled-tasks.json");

export interface RecurrenceConfig {
  type: "once" | "daily" | "weekly" | "monthly" | "custom";
  intervalMs?: number; // for "custom" type
  daysOfWeek?: number[]; // for "weekly" — 0=Sun, 1=Mon, ..., 6=Sat
}

export type ScheduledTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface TaskRun {
  sessionId: string;
  codexDriver?: CodexDriver;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed";
  trigger?: "scheduled" | "manual";
  resumeTaskStatus?: Exclude<ScheduledTaskStatus, "running">;
  resultSummary?: string;
  error?: string;
}

export interface ScheduledTask {
  id: string;
  name?: string;
  prompt: string;
  cwd: string;
  backend?: Backend;
  codexDriver?: CodexDriver;
  model?: string;
  effort?: AgentEffort;
  permissionMode?: string;
  scheduledTime: string;
  createdAt: string;
  status: ScheduledTaskStatus;
  sessionId?: string;
  resultSummary?: string;
  error?: string;
  createdBySessionId?: string;
  // Recurrence
  recurrence?: RecurrenceConfig;
  reuseSession?: boolean;
  notificationMode?: "completion" | "quiet";
  runCount?: number;
  lastRunAt?: string;
  /** The newest task result the user has acknowledged in the app. */
  lastReadAt?: string;
  /** Hidden from the active task list while remaining restorable. */
  archivedAt?: string;
  // History of all runs (for recurring tasks)
  runs?: TaskRun[];
}

/** Return a copy with durable result read state updated. */
export function setScheduledTaskReadState(
  task: ScheduledTask,
  read: boolean,
  now: Date = new Date(),
): ScheduledTask {
  const updated = { ...task };
  if (read) {
    updated.lastReadAt = now.toISOString();
  } else {
    delete updated.lastReadAt;
  }
  return updated;
}

export function scheduledTaskCanArchive(
  task: Pick<ScheduledTask, "recurrence" | "status" | "archivedAt">,
): boolean {
  const oneOff = !task.recurrence || task.recurrence.type === "once";
  const terminal = task.status === "completed"
    || task.status === "failed"
    || task.status === "cancelled";
  return oneOff && terminal && !task.archivedAt;
}

/** Return a copy with durable archive state updated. Archiving acknowledges its result. */
export function setScheduledTaskArchiveState(
  task: ScheduledTask,
  archived: boolean,
  now: Date = new Date(),
): ScheduledTask {
  const updated = { ...task };
  if (archived) {
    const timestamp = now.toISOString();
    updated.archivedAt = timestamp;
    updated.lastReadAt = timestamp;
  } else {
    delete updated.archivedAt;
  }
  return updated;
}

export function scheduledTaskDisplayName(task: Pick<ScheduledTask, "name" | "prompt">): string {
  const explicit = task.name?.trim().replace(/\s+/g, " ");
  if (explicit) return explicit.slice(0, 100);
  const firstPromptLine = task.prompt
    .split(/\r?\n/, 1)[0]
    ?.trim()
    .replace(/\s+/g, " ");
  if (!firstPromptLine) return "Scheduled task";
  return firstPromptLine.length > 100
    ? `${firstPromptLine.slice(0, 97)}...`
    : firstPromptLine;
}

export function scheduledTaskUsesAutomaticNotifications(
  task: Pick<ScheduledTask, "notificationMode">,
): boolean {
  return task.notificationMode !== "quiet";
}

function ensureDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function readTasks(): ScheduledTask[] {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8")) as ScheduledTask[];
  } catch {
    return [];
  }
}

function writeTasks(tasks: ScheduledTask[]): void {
  ensureDir();
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

export function listScheduledTasks(): ScheduledTask[] {
  return readTasks().sort(
    (a, b) => new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime()
  );
}

export function scheduledTaskRevisionForPath(filePath: string): string {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

export function getScheduledTaskRevision(): string {
  return scheduledTaskRevisionForPath(TASKS_FILE);
}

export function getScheduledTask(id: string): ScheduledTask | undefined {
  return readTasks().find((t) => t.id === id);
}

export function saveScheduledTask(task: ScheduledTask): void {
  const tasks = readTasks();
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) {
    tasks[idx] = task;
  } else {
    tasks.push(task);
  }
  writeTasks(tasks);
}

export function deleteScheduledTask(id: string): void {
  const tasks = readTasks().filter((t) => t.id !== id);
  writeTasks(tasks);
}

export function getDueTasks(): ScheduledTask[] {
  const now = Date.now();
  return readTasks().filter(
    (t) => !t.archivedAt
      && t.status === "pending"
      && new Date(t.scheduledTime).getTime() <= now
  );
}

/** Calculate the next scheduled time for a recurring task */
export function getNextRunTime(task: ScheduledTask, nowMs: number = Date.now()): string | null {
  if (!task.recurrence || task.recurrence.type === "once") return null;

  const last = new Date(task.scheduledTime);
  let next: Date;

  switch (task.recurrence.type) {
    case "daily":
      next = new Date(last.getTime() + 24 * 60 * 60 * 1000);
      break;
    case "weekly":
      next = new Date(last.getTime() + 7 * 24 * 60 * 60 * 1000);
      break;
    case "monthly": {
      next = new Date(last);
      next.setMonth(next.getMonth() + 1);
      break;
    }
    case "custom":
      if (!task.recurrence.intervalMs) return null;
      next = new Date(last.getTime() + task.recurrence.intervalMs);
      break;
    default:
      return null;
  }

  // If next is still in the past, advance until it's in the future
  while (next.getTime() <= nowMs) {
    switch (task.recurrence.type) {
      case "daily":
        next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
        break;
      case "weekly":
        next = new Date(next.getTime() + 7 * 24 * 60 * 60 * 1000);
        break;
      case "monthly":
        next.setMonth(next.getMonth() + 1);
        break;
      case "custom":
        next = new Date(next.getTime() + task.recurrence!.intervalMs!);
        break;
    }
  }

  return next.toISOString();
}

const INTERRUPTED_RUN_ERROR =
  "Scheduler ownership was lost during a server restart; this run could not be finalized.";

/**
 * Reconcile a task whose in-memory executor disappeared with the old process.
 * This is intentionally conservative: recurring scheduled runs advance to the
 * next occurrence rather than being replayed and potentially duplicating side
 * effects. One-shot runs become failed. Interrupted manual runs return to the
 * task status they had before Execute Now was pressed.
 */
export function reconcileInterruptedScheduledTask(
  task: ScheduledTask,
  now: Date = new Date(),
): ScheduledTask | null {
  if (task.status !== "running") return null;

  const recovered: ScheduledTask = {
    ...task,
    runs: (task.runs || []).map((run) => ({ ...run })),
  };
  const runs = recovered.runs!;
  let interruptedRun: TaskRun | undefined;
  for (let index = runs.length - 1; index >= 0; index--) {
    if (runs[index].status === "running") {
      interruptedRun = runs[index];
      break;
    }
  }

  if (!interruptedRun) {
    interruptedRun = {
      sessionId: recovered.sessionId || "",
      ...(recovered.codexDriver ? { codexDriver: recovered.codexDriver } : {}),
      startedAt: recovered.scheduledTime,
      status: "running",
      trigger: "scheduled",
    };
    runs.push(interruptedRun);
  }

  interruptedRun.status = "failed";
  interruptedRun.completedAt = now.toISOString();
  interruptedRun.error = INTERRUPTED_RUN_ERROR;
  recovered.runCount = (recovered.runCount || 0) + 1;
  recovered.lastRunAt = now.toISOString();
  recovered.error = INTERRUPTED_RUN_ERROR;

  if (interruptedRun.trigger === "manual") {
    recovered.status = interruptedRun.resumeTaskStatus || "completed";
  } else if (recovered.recurrence && recovered.recurrence.type !== "once") {
    const nextTime = getNextRunTime(recovered, now.getTime());
    if (nextTime) {
      recovered.status = "pending";
      recovered.scheduledTime = nextTime;
    } else {
      recovered.status = "failed";
    }
  } else {
    recovered.status = "failed";
  }

  return recovered;
}

/** Repair every orphaned running task after a server process starts. */
export function reconcileInterruptedScheduledTasks(
  now: Date = new Date(),
): ScheduledTask[] {
  const tasks = readTasks();
  const recovered: ScheduledTask[] = [];
  let changed = false;
  const reconciled = tasks.map((task) => {
    const replacement = reconcileInterruptedScheduledTask(task, now);
    if (!replacement) return task;
    changed = true;
    recovered.push(replacement);
    return replacement;
  });
  if (changed) writeTasks(reconciled);
  return recovered;
}

/** Get all session IDs that belong to scheduled tasks */
export function getScheduledTaskSessionIds(): Set<string> {
  const tasks = readTasks();
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.sessionId) ids.add(t.sessionId);
    if (t.runs) {
      for (const run of t.runs) {
        if (run.sessionId) ids.add(run.sessionId);
      }
    }
  }
  return ids;
}
