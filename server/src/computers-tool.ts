import { z } from "zod";
import type { ComputerAccess, ComputerConfirm } from "./protocol";
import { errorMessage } from "./value-guards";
import type { McpTextResult } from "./app-tool-handlers";

export const COMPUTERS_TOOL_DESCRIPTION =
  "Act on the user's other computers that are linked to this one through SocketAgent. list shows linked computers with online state and what each allows, plus known computers that are not linked yet. run executes a shell command on a computer and returns its output. sessions, transcript and search read that computer's SocketAgent sessions. request_access posts a card in this chat asking the user to link a computer with the access you need; it waits for the answer. The target computer enforces access and may ask the user to approve each action; when it does, the user sees a card in this chat and the call waits for it. To run a full agent on another computer, use AgentSession with the computer argument.";

export const COMPUTERS_TOOL_INPUT = {
  action: z.enum(["list", "run", "sessions", "transcript", "search", "request_access"]).describe("list linked computers; run a command; list sessions; read a transcript; search transcripts; or ask the user to link a computer"),
  computer: z.string().optional().describe("Linked computer name (case-insensitive) or its public key. Required for every action except list."),
  command: z.string().optional().describe("For run: the shell command. The computer's login shell runs it."),
  cwd: z.string().optional().describe("For run: working directory on that computer. Defaults to its home directory."),
  timeout_seconds: z.number().int().min(1).max(600).optional().describe("For run: seconds before the whole process tree is killed. Default 120."),
  session_id: z.string().optional().describe("For transcript: the session on that computer"),
  after_seq: z.number().int().nonnegative().optional().describe("For transcript: return entries after this sequence"),
  limit: z.number().int().min(1).max(50).optional().describe("For sessions, transcript and search: maximum entries"),
  query: z.string().optional().describe("For search: words to find in that computer's transcripts"),
  access: z.object({ read: z.boolean(), agents: z.boolean(), commands: z.boolean() }).optional().describe("For request_access: what you need"),
  reason: z.string().optional().describe("For request_access: one sentence the user sees explaining why"),
};

export interface ComputersToolArgs {
  action: "list" | "run" | "sessions" | "transcript" | "search" | "request_access";
  computer?: string;
  command?: string;
  cwd?: string;
  timeout_seconds?: number;
  session_id?: string;
  after_seq?: number;
  limit?: number;
  query?: string;
  access?: ComputerAccess;
  reason?: string;
}

export interface ComputersToolListEntry {
  name: string;
  publicKey: string;
  linked: boolean;
  online?: boolean;
  offlineReason?: string;
  access?: ComputerAccess;
  confirm?: ComputerConfirm;
}

/** Index.ts supplies this; it owns the links, the cards and the session. */
export type ComputersToolExecutor = (args: ComputersToolArgs, signal?: AbortSignal) => Promise<unknown>;

export async function handleComputersTool(
  ctx: { manageComputers?: ComputersToolExecutor; getAbortSignal?(): AbortSignal | undefined },
  args: ComputersToolArgs,
): Promise<McpTextResult> {
  if (!ctx.manageComputers) {
    return { content: [{ type: "text", text: "Computers is unavailable because this SocketAgent session is not attached to the link runtime." }], isError: true };
  }
  try {
    const result = await ctx.manageComputers(args, ctx.getAbortSignal?.());
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    return { content: [{ type: "text", text: `Computers error: ${errorMessage(err) || String(err)}` }], isError: true };
  }
}
