import { z } from "zod";
import { isRecord as isCodexRecord } from "./value-guards";
export { isRecord as isCodexRecord } from "./value-guards";

// Validate the fields rewind relies on. Additional provider fields remain compatible.
const turnSchema = z.object({
  id: z.string().min(1),
  items: z.array(z.unknown()).nullish(),
});
const threadSchema = z.object({
  historyMode: z.string().nullish(),
  status: z.object({ type: z.string() }).nullish(),
  turns: z.array(turnSchema),
});
const pageSchema = z.object({
  data: z.array(turnSchema),
  nextCursor: z.string().nullish(),
});
const userMessageSchema = z.object({
  type: z.literal("userMessage"),
  id: z.string().nullish(),
  clientId: z.string().nullish(),
  content: z.array(z.unknown()).nullish(),
});

export function parseRewindThread(value: unknown) {
  const result = threadSchema.safeParse(value);
  if (!result.success) throw new Error("Codex did not return valid conversation turns");
  if (result.data.status?.type === "active") throw new Error("Stop the running Codex turn before rewinding");
  return result.data;
}

export function parseRewindResponse(value: unknown) {
  return parseRewindThread(isCodexRecord(value) ? value.thread : undefined);
}

export function parseRewindPage(value: unknown) {
  const result = pageSchema.safeParse(value);
  if (!result.success) throw new Error("Codex did not return valid retained turns after rewind");
  return result.data;
}

export function readRewindHistoryMode(value: unknown) {
  if (!isCodexRecord(value) || !isCodexRecord(value.thread)) return undefined;
  return typeof value.thread.historyMode === "string" ? value.thread.historyMode : undefined;
}

export function parseRewindUserMessage(value: unknown) {
  if (!isCodexRecord(value) || value.type !== "userMessage") return undefined;
  const result = userMessageSchema.safeParse(value);
  if (!result.success) throw new Error("Codex returned an invalid user message. Nothing was rewound");
  const text: string[] = [];
  for (const part of result.data.content ?? []) {
    if (!isCodexRecord(part) || part.type !== "text") continue;
    if (typeof part.text !== "string") throw new Error("Codex returned invalid prompt text. Nothing was rewound");
    text.push(part.text);
  }
  return { id: result.data.id, clientId: result.data.clientId, text: text.join("\n").trim() };
}
