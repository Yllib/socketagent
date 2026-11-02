import type { DelegatedAgentRecord } from "./delegated-agent-types";
import type { DurableMonitorRecord } from "./durable-monitor-store";
import type { ScheduledTask } from "./scheduled-task-store";
import type { SessionMemoryState, SessionMemorySettings } from "./session-memory-store";
import type { Job, Header } from "./session-transfer-jobs";

// Legacy memory snapshots may omit settings that receive defaults on load.
export type StoredSessionMemory = Omit<Partial<SessionMemoryState>, "settings"> & {
  settings?: Partial<SessionMemorySettings>;
};

/** Runtime schemas are generated from the same contracts used by writers. */
export interface StoredDataContracts {
  delegation: DelegatedAgentRecord;
  monitor: DurableMonitorRecord;
  scheduledTask: ScheduledTask;
  sessionMemory: StoredSessionMemory;
  transferJob: Job;
  transferHeader: Header;
}
