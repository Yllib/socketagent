import * as fs from "fs";
import * as path from "path";
import type {
  DelegatedAgentRecord,
  DelegatedAgentRun,
  DelegatedAgentStatus,
} from "./delegated-agent-types";
import { socketAgentDataPath } from "./socket-agent-paths";

const STORE_FILE = socketAgentDataPath("delegated-agent-sessions.json");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readRecords(): DelegatedAgentRecord[] {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is DelegatedAgentRecord =>
      !!entry
      && typeof entry.delegationId === "string"
      && typeof entry.supervisorSessionId === "string"
      && Array.isArray(entry.runs),
    );
  } catch (err: any) {
    console.warn(`[DelegatedAgent] Failed to read store: ${err?.message || err}`);
    return [];
  }
}

function writeRecords(records: DelegatedAgentRecord[]): void {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(records, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, STORE_FILE);
}

export function listDelegatedAgents(supervisorSessionId?: string): DelegatedAgentRecord[] {
  return readRecords()
    .filter((record) => !supervisorSessionId || record.supervisorSessionId === supervisorSessionId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(clone);
}

export function getDelegatedAgent(
  id: string,
  supervisorSessionId?: string,
): DelegatedAgentRecord | undefined {
  const record = readRecords().find((candidate) =>
    (candidate.delegationId === id || candidate.childSessionId === id)
    && (!supervisorSessionId || candidate.supervisorSessionId === supervisorSessionId),
  );
  return record ? clone(record) : undefined;
}

export function saveDelegatedAgent(record: DelegatedAgentRecord): DelegatedAgentRecord {
  const records = readRecords();
  const next = clone({ ...record, updatedAt: new Date().toISOString() });
  const index = records.findIndex((candidate) => candidate.delegationId === next.delegationId);
  if (index >= 0) records[index] = next;
  else records.push(next);
  writeRecords(records);
  return clone(next);
}

export function updateDelegatedAgent(
  delegationId: string,
  patch: Partial<DelegatedAgentRecord>,
): DelegatedAgentRecord | undefined {
  const records = readRecords();
  const index = records.findIndex((record) => record.delegationId === delegationId);
  if (index < 0) return undefined;
  records[index] = {
    ...records[index],
    ...clone(patch),
    delegationId: records[index].delegationId,
    supervisorSessionId: records[index].supervisorSessionId,
    updatedAt: new Date().toISOString(),
  };
  writeRecords(records);
  return clone(records[index]);
}

export function addDelegatedAgentRun(
  delegationId: string,
  run: DelegatedAgentRun,
): DelegatedAgentRecord | undefined {
  const record = getDelegatedAgent(delegationId);
  if (!record) return undefined;
  record.runs = [...record.runs, clone(run)].slice(-100);
  record.status = run.status;
  return saveDelegatedAgent(record);
}

export function updateDelegatedAgentRun(
  delegationId: string,
  runId: string,
  patch: Partial<DelegatedAgentRun>,
  recordStatus?: DelegatedAgentStatus,
): DelegatedAgentRecord | undefined {
  const record = getDelegatedAgent(delegationId);
  if (!record) return undefined;
  const index = record.runs.findIndex((run) => run.runId === runId);
  if (index < 0) return undefined;
  record.runs[index] = {
    ...record.runs[index],
    ...clone(patch),
    runId: record.runs[index].runId,
    runNumber: record.runs[index].runNumber,
  };
  if (recordStatus) record.status = recordStatus;
  return saveDelegatedAgent(record);
}

export function pendingDelegatedAgentReports(): Array<{
  record: DelegatedAgentRecord;
  run: DelegatedAgentRun;
}> {
  const pending: Array<{ record: DelegatedAgentRecord; run: DelegatedAgentRun }> = [];
  for (const record of readRecords()) {
    for (const run of record.runs) {
      if (
        (run.status === "completed" || run.status === "failed" || run.status === "stopped")
        && run.reportStatus !== "delivered"
      ) {
        pending.push({ record: clone(record), run: clone(run) });
      }
    }
  }
  return pending.sort((left, right) => left.run.startedAt.localeCompare(right.run.startedAt));
}
