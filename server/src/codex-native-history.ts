import * as fs from "fs";
import * as os from "os";
import { isRecord, unknownArray } from "./value-guards";
import * as path from "path";
import type { HistoryEntry } from "./protocol";
import { normalizeCodexSubagentStatus, codexSubagentIsActive } from "./codex-subagent-state";

function nowIso(): string {
  return new Date().toISOString();
}

function epochToIso(value: unknown, fallback = nowIso()): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return epochToIso(n, fallback);
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return unknownArray(content).map((b) => {
      if (typeof b === "string") return b;
      if (isRecord(b) && typeof b.text === "string") return b.text;
      return "";
    }).join("");
  }
  return "";
}

function jsonPreview(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? ""); } catch { return String(value ?? ""); }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function noEmptyOutput(output: string): string {
  return output.trim().length > 0 ? output : "(no output)";
}

export function cleanCodexCommandOutput(output: unknown): string {
  let text = typeof output === "string" ? output : jsonPreview(output ?? "");
  const idx = text.indexOf("Output:\n");
  if (idx >= 0) text = text.substring(idx + "Output:\n".length);
  return noEmptyOutput(text);
}

function generatedImagePath(threadId: unknown, itemId: unknown): string | null {
  const thread = String(threadId || "").trim();
  const item = String(itemId || "").trim();
  if (!thread || !item) return null;
  const homeDir = process.env.HOME || os.homedir();
  return path.join(homeDir, ".codex", "generated_images", thread, `${item}.png`);
}

function imageFromResult(threadId: unknown, item: Record<string, unknown>): { filePath: string; mimeType: string } | null {
  const explicitPath = typeof item?.savedPath === "string" ? item.savedPath : "";
  const filePath = explicitPath || generatedImagePath(threadId, item?.id) || "";
  if (!filePath) return null;
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (fs.existsSync(resolved)) return { filePath: resolved, mimeType: "image/png" };

  let imageData = typeof item?.result === "string" ? item.result.trim() : "";
  if (!imageData) return null;
  const dataUrl = imageData.match(/^data:([^;,]+);base64,(.+)$/);
  const mimeType = dataUrl?.[1] || "image/png";
  if (dataUrl) imageData = dataUrl[2];
  if (!/^[A-Za-z0-9+/=\s]+$/.test(imageData)) return null;
  imageData = imageData.replace(/\s+/g, "");
  const bytes = Buffer.from(imageData, "base64");
  if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) return null;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, bytes);
  return { filePath: resolved, mimeType };
}

function normalizeToolName(name: unknown): string {
  const raw = String(name || "tool");
  if (raw === "exec_command") return "Bash";
  if (raw === "apply_patch") return "ApplyPatch";
  return raw;
}

function toolCallContent(toolName: string, args: Record<string, unknown>, fallback = ""): string {
  if (toolName === "Bash") {
    const cmd = args.cmd ?? args.command;
    return typeof cmd === "string" ? cmd : fallback || jsonPreview(args);
  }
  if (toolName === "ApplyPatch") {
    const patch = args.patch ?? args.input;
    return typeof patch === "string" ? patch : fallback || jsonPreview(args);
  }
  return fallback || jsonPreview(args);
}

function pushToolResult(
  result: HistoryEntry[],
  toolUseId: string,
  output: string,
  timestamp: string,
): void {
  const value = noEmptyOutput(output);
  result.push({
    role: "tool_result",
    content: value,
    toolUseId,
    toolOutput: value,
    timestamp,
  });
}

export function codexRolloutJsonlToHistory(raw: string, options: { threadId?: string } = {}): HistoryEntry[] {
  const result: HistoryEntry[] = [];
  const turnStarts: Array<{ id?: string; index: number }> = [];
  let explicitTurns = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!isRecord(obj) || !isRecord(obj.payload)) continue;
    const timestamp = typeof obj.timestamp === "string" && obj.timestamp ? obj.timestamp : nowIso();
    const payload = obj.payload;

    if (obj.type === "event_msg") {
      if (payload.type === "task_started") {
        explicitTurns = true;
        const id = String(payload.turn_id || "");
        if (!id || turnStarts.at(-1)?.id !== id) turnStarts.push({ id, index: result.length });
      } else if (payload.type === "thread_rolled_back") {
        const count = Number(payload.num_turns);
        if (Number.isSafeInteger(count) && count > 0 && turnStarts.length) {
          const keep = Math.max(0, turnStarts.length - count);
          result.splice(turnStarts[keep].index);
          turnStarts.splice(keep);
        }
      } else if (payload.type === "user_message") {
        if (!explicitTurns) turnStarts.push({ index: result.length });
        const content = String(payload.message ?? "");
        if (content) result.push({ role: "user", content, timestamp });
      } else if (payload.type === "context_compacted") {
        const tokens = Number(payload.tokens_removed ?? payload.tokensCompacted ?? payload.tokens ?? 0);
        result.push({
          role: "assistant",
          content: tokens > 0 ? `Compacted ${tokens.toLocaleString()} tokens.` : "Context compacted.",
          timestamp,
        });
      }
      continue;
    }

    if (obj.type !== "response_item") continue;

    if (payload.type === "message") {
      if (payload.role === "assistant") {
        const text = extractText(payload.content);
        if (text) result.push({ role: "assistant", content: text, timestamp });
      }
      continue;
    }

    if (payload.type === "reasoning") {
      const content = extractText(payload.summary) || extractText(payload.content);
      result.push({
        role: "assistant",
        content,
        thinking: true,
        streamId: String(payload.id || `reasoning_${timestamp}`),
        timestamp,
      });
      continue;
    }

    if (payload.type === "function_call") {
      const args = parseJsonObject(payload.arguments);
      const toolName = normalizeToolName(payload.name);
      result.push({
        role: "tool_call",
        content: toolCallContent(toolName, args),
        toolName,
        toolInput: args,
        toolUseId: typeof payload.call_id === "string" ? payload.call_id : undefined,
        timestamp,
      });
      continue;
    }

    if (payload.type === "function_call_output") {
      pushToolResult(result, String(payload.call_id || ""), cleanCodexCommandOutput(payload.output), timestamp);
      continue;
    }

    if (payload.type === "custom_tool_call") {
      const toolName = normalizeToolName(payload.name);
      const input = typeof payload.input === "string" ? payload.input : jsonPreview(payload.input ?? "");
      const args = toolName === "ApplyPatch" ? { patch: input } : { input };
      result.push({
        role: "tool_call",
        content: toolCallContent(toolName, args, input),
        toolName,
        toolInput: args,
        toolUseId: typeof payload.call_id === "string" ? payload.call_id : undefined,
        timestamp,
      });
      continue;
    }

    if (payload.type === "custom_tool_call_output") {
      pushToolResult(result, String(payload.call_id || ""), cleanCodexCommandOutput(payload.output), timestamp);
      continue;
    }

    if (payload.type === "tool_search_call") {
      const args = parseJsonObject(payload.arguments);
      result.push({
        role: "tool_call",
        content: toolCallContent("ToolSearch", args),
        toolName: "ToolSearch",
        toolInput: args,
        toolUseId: typeof payload.call_id === "string" ? payload.call_id : undefined,
        timestamp,
      });
      continue;
    }

    if (payload.type === "tool_search_output") {
      const output = jsonPreview(payload.tools ?? payload.output ?? "");
      pushToolResult(result, String(payload.call_id || ""), output, timestamp);
      continue;
    }

    if (payload.type === "web_search_call") {
      const action = isRecord(payload.action) ? payload.action : {};
      const query = typeof action.query === "string" ? action.query : jsonPreview(action);
      result.push({
        role: "tool_call",
        content: query,
        toolName: "WebSearch",
        toolInput: action,
        toolUseId: typeof payload.call_id === "string" && payload.call_id ? payload.call_id : `web_${timestamp}`,
        timestamp,
      });
      continue;
    }

    if (payload.type === "image_generation_call") {
      const toolUseId = String(payload.id || payload.call_id || `image_${timestamp}`);
      const image = imageFromResult(options.threadId, payload);
      const input = {
        status: payload.status,
        revisedPrompt: payload.revised_prompt ?? payload.revisedPrompt ?? null,
      };
      result.push({
        role: "tool_call",
        content: "ImageGeneration",
        toolName: "ImageGeneration",
        toolInput: input,
        toolUseId,
        timestamp,
      });
      if (image) {
        result.push({
          role: "tool_image",
          content: "",
          toolUseId,
          filePath: image.filePath,
          mimeType: image.mimeType,
          timestamp,
        });
      }
      pushToolResult(result, toolUseId, image?.filePath || String(payload.status || "Image generation completed"), timestamp);
      continue;
    }
  }
  return result.filter((entry) => entry.role !== "tool_result" || !!entry.toolUseId);
}

function appServerUserInputToText(input: unknown): string {
  if (!isRecord(input)) return "";
  if (input.type === "text") return String(input.text ?? "");
  if (input.type === "skill") return `/${String(input.name ?? "skill")}`;
  return "";
}

export function codexAppServerThreadToHistory(thread: unknown): HistoryEntry[] {
  const result: HistoryEntry[] = [];
  if (!isRecord(thread)) return result;
  const threadId = thread?.id || thread?.sessionId || "";
  const agents = new Map<string, { card: HistoryEntry; status: string }>();
  const ensureAgent = (agentId: string, timestamp: string, details: Record<string, unknown> = {}) => {
    if (!agentId || agentId === threadId) return undefined;
    let agent = agents.get(agentId);
    if (!agent) {
      const prompt = typeof details.prompt === "string" ? details.prompt.trim().slice(0, 160) : "";
      const leaf = typeof details.agentPath === "string" ? details.agentPath.split('/').filter(Boolean).at(-1)?.replace(/[_-]+/g, ' ') : "";
      const description = prompt || leaf || 'Codex agent';
      const card: HistoryEntry = {
        role: 'tool_call', toolName: 'Agent', content: description,
        toolUseId: `codex-subagent:${agentId}`, timestamp,
        toolInput: { description, subagent_type: 'codex', agentId },
      };
      agent = { card, status: 'pending' };
      agents.set(agentId, agent);
      result.push(card);
    }
    for (const key of ['prompt', 'model', 'reasoningEffort', 'agentPath']) {
      if (typeof details[key] === 'string' && details[key]) agent.card.toolInput![key] = details[key];
    }
    if (typeof details.prompt === "string" && details.prompt) {
      agent.card.content = details.prompt.trim().slice(0, 160);
      agent.card.toolInput!.description = agent.card.content;
    }
    return agent;
  };
  const setAgentStatus = (agentId: string, rawStatus: unknown, timestamp: string, message?: string) => {
    const status = normalizeCodexSubagentStatus(rawStatus);
    if (!status) return;
    const agent = ensureAgent(agentId, timestamp);
    if (!agent || agent.status === status) return;
    agent.status = status;
    if (!codexSubagentIsActive(status)) {
      const output = message || `Codex subagent ${status}`;
      result.push({ role: 'tool_result', toolUseId: agent.card.toolUseId,
        content: output, toolOutput: output, subagentStatus: status, timestamp });
    }
  };
  const turns = unknownArray(thread.turns);
  for (const turn of turns) {
    if (!isRecord(turn)) continue;
    const timestamp = epochToIso(turn?.startedAt ?? turn?.completedAt, nowIso());
    const items = unknownArray(turn.items);
    for (const item of items) {
      if (!isRecord(item)) continue;

      if (item.type === 'subAgentActivity') {
        const id = String(item.agentThreadId || '');
        if (item.kind === 'interacted') {
          if (agents.has(id)) ensureAgent(id, timestamp, item);
        } else {
          const agent = ensureAgent(id, timestamp, item);
          if (item.kind === 'completed' && agent && ['pending', 'running'].includes(agent.status)) {
            setAgentStatus(id, 'completed', timestamp);
          } else if (item.kind === 'interrupted') {
            setAgentStatus(id, 'interrupted', timestamp);
          }
        }
        continue;
      }
      if (item.type === 'collabAgentToolCall') {
        if (item.tool === 'spawnAgent') {
          for (const id of unknownArray(item.receiverThreadIds)) ensureAgent(String(id), timestamp, item);
        }
        const states = isRecord(item.agentsStates) ? item.agentsStates : {};
        for (const [id, state] of Object.entries(states)) {
          if (!isRecord(state)) continue;
          setAgentStatus(id, state.status, timestamp, typeof state.message === "string" ? state.message : undefined);
        }
        continue;
      }

      if (item.type === "userMessage") {
        const content = unknownArray(item.content)
          .map(appServerUserInputToText)
          .filter(Boolean)
          .join("\n")
          .trim();
        if (content) result.push({ role: "user", content, timestamp, ...(typeof item.clientId === "string" && item.clientId ? { uuid: item.clientId } : {}) });
        continue;
      }

      if (item.type === "agentMessage") {
        const text = String(item.text ?? "");
        if (text) result.push({ role: "assistant", content: text, timestamp });
        continue;
      }

      if (item.type === "commandExecution") {
        const command = String(item.command ?? "");
        result.push({
          role: "tool_call",
          content: command,
          toolName: "Bash",
          toolInput: { command, cwd: item.cwd },
          toolUseId: typeof item.id === "string" ? item.id : undefined,
          timestamp,
        });
        if (item.aggregatedOutput != null || item.exitCode != null) {
          const suffix = item.exitCode ? `\n[exit ${item.exitCode}]` : "";
          pushToolResult(result, String(item.id || ""), `${String(item.aggregatedOutput ?? "")}${suffix}`, timestamp);
        }
        continue;
      }

      if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
        const toolName = item.type === "mcpToolCall"
          ? `${item.server || "mcp"}.${item.tool || "tool"}`
          : `${item.namespace || "dynamic"}.${item.tool || "tool"}`;
        const args = isRecord(item.arguments) ? item.arguments : {};
        result.push({
          role: "tool_call",
          content: jsonPreview(args),
          toolName,
          toolInput: args,
          toolUseId: typeof item.id === "string" ? item.id : undefined,
          timestamp,
        });
        const output = jsonPreview(item.result ?? item.error ?? item.contentItems ?? "");
        if (output) pushToolResult(result, String(item.id || ""), output, timestamp);
        continue;
      }

      if (item.type === "fileChange") {
        const changes = unknownArray(item.changes);
        result.push({
          role: "tool_call",
          content: jsonPreview(changes),
          toolName: "ApplyPatch",
          toolInput: { changes },
          toolUseId: typeof item.id === "string" ? item.id : undefined,
          timestamp,
        });
        pushToolResult(result, String(item.id || ""), item.status ? `Patch ${item.status}` : "Patch complete", timestamp);
        continue;
      }

      if (item.type === "imageView") {
        const imagePath = String(item.path ?? "");
        result.push({
          role: "tool_call",
          content: imagePath,
          toolName: "ViewImage",
          toolInput: { path: imagePath },
          toolUseId: typeof item.id === "string" ? item.id : undefined,
          timestamp,
        });
        if (imagePath) {
          result.push({
            role: "tool_image",
            content: "",
            toolUseId: typeof item.id === "string" ? item.id : undefined,
            filePath: imagePath,
            mimeType: "image/png",
            timestamp,
          });
        }
        pushToolResult(result, String(item.id || ""), imagePath || "Image viewed", timestamp);
        continue;
      }

      if (item.type === "imageGeneration") {
        const input = { status: item.status, revisedPrompt: item.revisedPrompt ?? null };
        const image = imageFromResult(threadId, item);
        result.push({
          role: "tool_call",
          content: "ImageGeneration",
          toolName: "ImageGeneration",
          toolInput: input,
          toolUseId: typeof item.id === "string" ? item.id : undefined,
          timestamp,
        });
        if (image) {
          result.push({
            role: "tool_image",
            content: "",
            toolUseId: typeof item.id === "string" ? item.id : undefined,
            filePath: image.filePath,
            mimeType: image.mimeType,
            timestamp,
          });
        }
        pushToolResult(result, String(item.id || ""), image?.filePath || String(item.status || "Image generation completed"), timestamp);
        continue;
      }
    }
  }
  return result.filter((entry) => entry.role !== "tool_result" || !!entry.toolUseId);
}
