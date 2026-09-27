import { isRecord, unknownArray } from "./value-guards";

interface BlockState { index: number; type: string; claimed: boolean }
interface MessageState { blocks: BlockState[]; completed: Map<string, string[]> }

/** API message ids identify a model response, not individual SDK content blocks. */
export class ClaudeStreamIdentity {
  private active = new Map<string, string>();
  private messages = new Map<string, MessageState>();

  clear(): void { this.active.clear(); this.messages.clear(); }

  private messageKey(message: Record<string, unknown>): string {
    const lane = String(message.parent_tool_use_id || "main");
    const event = message.type === "stream_event" && isRecord(message.event) ? message.event : {};
    const eventMessage = isRecord(event.message) ? event.message : {};
    const completeMessage = isRecord(message.message) ? message.message : {};
    const id = eventMessage.id || completeMessage.id;
    if (id) this.active.set(lane, String(id));
    return `${lane}:${id || this.active.get(lane) || message.uuid || "current"}`;
  }

  private state(key: string): MessageState {
    let state = this.messages.get(key);
    if (!state) {
      state = { blocks: [], completed: new Map<string, string[]>() };
      this.messages.set(key, state);
      // Keep completed-message reconciliation bounded in warm sessions.
      if (this.messages.size > 512) this.messages.delete(this.messages.keys().next().value!);
    }
    return state;
  }

  streamKey(value: unknown): string {
    const message = isRecord(value) ? value : {};
    const key = this.messageKey(message);
    const event = message.event;
    if (message.type !== "stream_event" || !isRecord(event) || typeof event.index !== "number" || !Number.isInteger(event.index)) return key;
    const index = event.index;
    const state = this.state(key);
    if (!state.blocks.some(block => block.index === index)) {
      const block = isRecord(event.content_block) ? event.content_block : {};
      const delta = isRecord(event.delta) ? event.delta : {};
      const type = typeof block.type === "string" && block.type ? block.type
        : delta.type === "thinking_delta" ? "thinking" : delta.type === "text_delta" ? "text" : "tool_use";
      state.blocks.push({ index, type, claimed: false });
    }
    return `${key}:block:${event.index}`;
  }

  completedKeys(value: unknown): string[] {
    const message = isRecord(value) ? value : {};
    const key = this.messageKey(message);
    const state = this.state(key);
    const uuid = String(message.uuid || "");
    const existing = uuid && state.completed.get(uuid);
    if (existing) return existing;
    const completeMessage = isRecord(message.message) ? message.message : {};
    const keys = unknownArray(completeMessage.content).map((block, offset) => {
      const blockType = isRecord(block) ? block.type : undefined;
      const streamed = state.blocks.find(candidate => !candidate.claimed && candidate.type === blockType);
      if (streamed) {
        streamed.claimed = true;
        return `${key}:block:${streamed.index}`;
      }
      // Without partial events the SDK's outer UUID is the block identity.
      return `${key}:complete:${uuid || "unknown"}:${offset}`;
    });
    if (uuid) state.completed.set(uuid, keys);
    return keys;
  }
}
