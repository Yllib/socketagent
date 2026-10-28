import * as crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AiConnectorGrant } from "./ai-connector-store";
import type { ComputersToolListEntry } from "./computers-tool";
import type { PeerAction } from "./computer-link-peer";
import type { McpTextResult } from "./app-tool-handlers";
import { errorMessage } from "./value-guards";

/**
 * The tools an AI client gets through the connector. Each one is a peer
 * action, the same ones linked computers exchange, run on this computer or
 * on a computer linked to it. The host decides access and raises the
 * approval cards; this file only shapes arguments and results.
 */

export interface AiConnectorToolHost {
  serverName(): string;
  /** This computer first, then linked and known computers. */
  listComputers(): ComputersToolListEntry[];
  /**
   * Runs one action for the client. `computer` undefined or naming this
   * computer runs here under the client's own access and confirm settings;
   * any other name goes through the link to that computer.
   */
  act(grant: AiConnectorGrant, computer: string | undefined, action: PeerAction, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Records the call in the client's session and shows it on connected phones. */
  logCall(grant: AiConnectorGrant, toolUseId: string, tool: string, input: Record<string, unknown>): void;
  logResult(grant: AiConnectorGrant, toolUseId: string, output: string, isError: boolean): void;
}

const computerArg = z.string().optional().describe("A computer name from list_computers. Omit for the computer that runs the connector.");
const backendArg = z.enum(["claude", "codex"]).optional();
const effortArg = z.enum(["minimal", "low", "medium", "high", "max", "xhigh", "ultra"]).optional();

function text(value: unknown, isError = false): McpTextResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/** The tools for one signed-in client. A new server is built per request. */
export function createAiConnectorMcpServer(grant: AiConnectorGrant, host: AiConnectorToolHost): McpServer {
  const server = new McpServer({ name: "socketagent", version: "1.0.0" }, {
    instructions: `SocketAgent on ${host.serverName()} gives you the user's computers: run shell commands, read agent session transcripts, and start or steer full Claude or Codex agent sessions. Start with list_computers. The user approves actions on their phone; a call that needs approval waits for the answer, so tell the user when you are waiting. Actions can be refused by the user or by that computer's access settings.`,
  });

  const run = async (tool: string, input: Record<string, unknown>, work: () => Promise<unknown>): Promise<McpTextResult> => {
    const toolUseId = `connector_${crypto.randomUUID()}`;
    host.logCall(grant, toolUseId, tool, input);
    try {
      const result = await work();
      const rendered = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      host.logResult(grant, toolUseId, rendered, false);
      return text(rendered);
    } catch (err: unknown) {
      const message = errorMessage(err) || String(err);
      host.logResult(grant, toolUseId, message, true);
      return text(message, true);
    }
  };

  server.registerTool("list_computers", {
    title: "List computers",
    description: "The user's computers: the one running the connector, computers linked to it with their online state and what each allows, and known computers that are not linked yet. Use the names here as the computer argument of the other tools.",
    inputSchema: {},
  }, async () => run("list_computers", {}, async () => ({
    this_computer: host.serverName(),
    computers: host.listComputers(),
  })));

  server.registerTool("run_command", {
    title: "Run a command",
    description: "Runs a shell command on a computer with its login shell and returns the exit code and output. Output is capped at 64 KB. The user may be asked to approve it on their phone.",
    inputSchema: {
      computer: computerArg,
      command: z.string().min(1).describe("The shell command"),
      cwd: z.string().optional().describe("Working directory on that computer. Defaults to its home directory."),
      timeout_seconds: z.number().int().min(1).max(600).optional().describe("Seconds before the process tree is killed. Default 120."),
    },
  }, async (args) => run("run_command", args, () => {
    const timeoutSeconds = Math.min(600, Math.max(1, args.timeout_seconds ?? 120));
    return host.act(grant, args.computer, "run_command", {
      command: args.command,
      ...(args.cwd ? { cwd: args.cwd } : {}),
      timeoutSeconds,
    }, (timeoutSeconds + 15) * 1000);
  }));

  server.registerTool("list_sessions", {
    title: "List sessions",
    description: "Recent SocketAgent agent sessions on a computer: id, title, backend, working directory, last activity and whether an agent is running in it.",
    inputSchema: {
      computer: computerArg,
      limit: z.number().int().min(1).max(50).optional().describe("Maximum sessions. Default 30."),
    },
  }, async (args) => run("list_sessions", args, () =>
    host.act(grant, args.computer, "sessions_list", { ...(args.limit ? { limit: args.limit } : {}) })));

  server.registerTool("read_transcript", {
    title: "Read a transcript",
    description: "Reads a session's transcript in order: user prompts, assistant text, tool calls and results. Page with after_seq from the returned next_session_seq until has_more is false.",
    inputSchema: {
      computer: computerArg,
      session_id: z.string().min(1).describe("A session id from list_sessions, or the session_id of an agent you started"),
      after_seq: z.number().int().nonnegative().optional().describe("Return entries after this sequence. Omit for the newest page."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum entries. Default 20."),
    },
  }, async (args) => run("read_transcript", args, () =>
    host.act(grant, args.computer, "transcript_read", {
      sessionId: args.session_id,
      ...(args.after_seq !== undefined ? { afterSeq: args.after_seq } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    })));

  server.registerTool("search_transcripts", {
    title: "Search transcripts",
    description: "Finds words in every session transcript on a computer and returns matching entries with their session ids.",
    inputSchema: {
      computer: computerArg,
      query: z.string().min(1).max(500).describe("Words to find"),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum hits. Default 20."),
    },
  }, async (args) => run("search_transcripts", args, () =>
    host.act(grant, args.computer, "transcript_search", { query: args.query, ...(args.limit ? { limit: args.limit } : {}) })));

  server.registerTool("start_agent", {
    title: "Start an agent",
    description: "Starts an independent Claude or Codex agent session on a computer with your prompt and returns at once with its session_id. The agent works on its own; check it with agent_status, read its transcript with read_transcript, send more instructions with message_agent, and end it with stop_agent.",
    inputSchema: {
      computer: computerArg,
      prompt: z.string().min(1).describe("Complete instructions for the agent"),
      backend: backendArg.describe("claude or codex. Defaults to what that computer prefers."),
      cwd: z.string().optional().describe("Absolute working directory on that computer. Defaults to its default directory."),
      label: z.string().max(100).optional().describe("Short label shown in the user's app"),
      model: z.string().optional().describe("Provider model id. Omit for the default."),
      effort: effortArg.describe("Reasoning effort"),
      permission_mode: z.enum(["plan", "default", "auto", "acceptEdits", "bypassPermissions", "superYolo"]).optional().describe("How much the agent may do without asking"),
    },
  }, async (args) => run("start_agent", args, () =>
    host.act(grant, args.computer, "agent_start", {
      prompt: args.prompt,
      ...(args.backend ? { backend: args.backend } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.label ? { label: args.label } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.permission_mode ? { permissionMode: args.permission_mode } : {}),
    })));

  server.registerTool("message_agent", {
    title: "Message an agent",
    description: "Sends a follow-up prompt to an agent you started. A running agent gets it at its next safe point; a finished one resumes.",
    inputSchema: {
      computer: computerArg,
      session_id: z.string().min(1).describe("The session_id returned by start_agent"),
      prompt: z.string().min(1),
    },
  }, async (args) => run("message_agent", args, () =>
    host.act(grant, args.computer, "agent_message", { session_id: args.session_id, prompt: args.prompt })));

  server.registerTool("agent_status", {
    title: "Agent status",
    description: "The state of an agent you started (starting, running, completed, failed or stopped), its latest result, and a page of its recent activity. Completion is not pushed to you, so check here when you need the outcome.",
    inputSchema: {
      computer: computerArg,
      session_id: z.string().min(1).describe("The session_id returned by start_agent"),
      after_seq: z.number().int().nonnegative().optional().describe("Return activity after this sequence. Omit for the newest page."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum activity entries. Default 20."),
    },
  }, async (args) => run("agent_status", args, () =>
    host.act(grant, args.computer, "agent_tail", {
      session_id: args.session_id,
      ...(args.after_seq !== undefined ? { after_session_seq: args.after_seq } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    })));

  server.registerTool("list_agents", {
    title: "List agents",
    description: "Every agent you started on a computer, with its state and label.",
    inputSchema: { computer: computerArg },
  }, async (args) => run("list_agents", args, () => host.act(grant, args.computer, "agent_list", {})));

  server.registerTool("stop_agent", {
    title: "Stop an agent",
    description: "Stops an agent you started. Its session and transcript stay readable.",
    inputSchema: {
      computer: computerArg,
      session_id: z.string().min(1).describe("The session_id returned by start_agent"),
    },
  }, async (args) => run("stop_agent", args, () => host.act(grant, args.computer, "agent_stop", { session_id: args.session_id })));

  return server;
}
