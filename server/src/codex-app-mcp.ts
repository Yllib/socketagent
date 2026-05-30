import { randomBytes } from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AppToolContext,
  handleMonitorTool,
  handleReadSkillTool,
  handleScheduleReminderTool,
  handleScheduleTaskTool,
  handleSearchSkillsTool,
  handleSendFileTool,
  handleSpeakTool,
} from "./app-tool-handlers";

interface CodexMcpRegistration {
  token: string;
  context: AppToolContext;
  transports: Map<string, StreamableHTTPServerTransport>;
}

const registrations = new Map<string, CodexMcpRegistration>();

export function registerCodexAppMcp(context: AppToolContext): { token: string; unregister: () => void } {
  const token = randomBytes(32).toString("base64url");
  const registration: CodexMcpRegistration = {
    token,
    context,
    transports: new Map(),
  };
  registrations.set(token, registration);
  return {
    token,
    unregister: () => unregisterCodexAppMcp(token),
  };
}

function unregisterCodexAppMcp(token: string): void {
  const registration = registrations.get(token);
  if (!registration) return;
  registrations.delete(token);
  for (const transport of registration.transports.values()) {
    void transport.close().catch((err) => {
      console.warn(`[Codex MCP] Failed to close transport: ${err.message}`);
    });
  }
  registration.transports.clear();
}

function createServer(context: AppToolContext): McpServer {
  const server = new McpServer({
    name: "socketagent-app",
    version: "1.0.0",
  });

  server.registerTool(
    "SearchSkills",
    {
      title: "Search Skills",
      description: "Search SocketAgent-managed Codex skills by name, description, or body. Use this when a user asks for behavior that may match a reusable skill.",
      inputSchema: {
        query: z.string().optional().describe("Search text. Leave empty to list available Codex skills."),
        limit: z.number().optional().describe("Maximum number of skills to return, 1-25"),
      },
    },
    async (args) => handleSearchSkillsTool(context, args as any),
  );

  server.registerTool(
    "ReadSkill",
    {
      title: "Read Skill",
      description: "Read a SocketAgent-managed Codex skill's SKILL.md instructions after finding it with SearchSkills.",
      inputSchema: {
        name: z.string().optional().describe("Skill name to read"),
        filePath: z.string().optional().describe("Exact skill file path returned by SearchSkills"),
      },
    },
    async (args) => handleReadSkillTool(context, args as any),
  );

  server.registerTool(
    "Speak",
    {
      title: "Speak",
      description: "Speak text aloud to the user via text-to-speech. Use this for concise spoken summaries only.",
      inputSchema: {
        text: z.string().describe("The text to speak aloud to the user"),
      },
    },
    async (args) => handleSpeakTool(context, args as { text: string }),
  );

  server.registerTool(
    "SendFile",
    {
      title: "Send File",
      description: "Send a file to the user's mobile device for download. Use this when the user asks you to send, share, or transfer a file to their phone.",
      inputSchema: {
        file_path: z.string().describe("Absolute path to the file to send"),
      },
    },
    async (args) => handleSendFileTool(context, args as { file_path: string }),
  );

  server.registerTool(
    "ScheduleReminder",
    {
      title: "Schedule Reminder",
      description: "Schedule a reminder notification on the user's mobile device.",
      inputSchema: {
        title: z.string().describe("Short title for the reminder notification"),
        body: z.string().optional().describe("Optional longer description for the notification body"),
        scheduledTime: z.string().describe("When to fire the reminder, in ISO 8601 format"),
      },
    },
    async (args) => handleScheduleReminderTool(context, args as { title: string; body?: string; scheduledTime: string }),
  );

  server.registerTool(
    "ScheduleTask",
    {
      title: "Schedule Task",
      description: "Schedule a Codex/Claude prompt to run automatically at a future time. Use this when the user wants to defer work until later.",
      inputSchema: {
        prompt: z.string().describe("The prompt/instructions to execute at the scheduled time"),
        cwd: z.string().describe("Working directory for the scheduled task (absolute path)"),
        scheduledTime: z.string().describe("When to run the task, in ISO 8601 format"),
        recurrenceType: z.enum(["once", "daily", "weekly", "monthly", "custom"]).optional().describe("How often to repeat. Default: once"),
        customIntervalMs: z.number().optional().describe("Custom interval in milliseconds when recurrenceType is custom"),
        reuseSession: z.boolean().optional().describe("If true and recurring, reuse the same session for all occurrences"),
      },
    },
    async (args) => handleScheduleTaskTool(context, args as any),
  );

  server.registerTool(
    "Monitor",
    {
      title: "Monitor",
      description: "Start a background shell command and monitor its output. Output is batched and delivered back into the session. For Codex, toggling is limited to Monitor-started task IDs.",
      inputSchema: {
        command: z.string().optional().describe("Shell command to run in background with monitoring enabled"),
        description: z.string().optional().describe("Human-readable description of the process"),
        timeoutSeconds: z.number().optional().describe("Auto-stop monitoring after N seconds; the process may continue"),
        taskId: z.string().optional().describe("Monitor-started task ID to stop/toggle"),
        enabled: z.boolean().optional().describe("Set false to stop monitoring a Monitor-started task"),
      },
    },
    async (args) => handleMonitorTool(context, args as any),
  );

  return server;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function getHeaderValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "DELETE") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : undefined;
}

export function isCodexAppMcpRequest(req: IncomingMessage): boolean {
  return !!req.url?.startsWith("/codex-mcp/");
}

export async function handleCodexAppMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const token = decodeURIComponent(url.pathname.slice("/codex-mcp/".length));
  const registration = registrations.get(token);
  if (!registration) {
    writeJson(res, 404, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unknown SocketAgent MCP session" },
      id: null,
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err: any) {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: `Invalid JSON: ${err.message}` },
      id: null,
    });
    return;
  }

  const mcpSessionId = getHeaderValue(req, "mcp-session-id");
  let transport: StreamableHTTPServerTransport | undefined;

  if (mcpSessionId) {
    transport = registration.transports.get(mcpSessionId);
  } else if (isInitializeRequest(body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(16).toString("hex"),
      onsessioninitialized: (sessionId) => {
        if (transport) registration.transports.set(sessionId, transport);
      },
    });
    transport.onclose = () => {
      const sid = transport?.sessionId;
      if (sid) registration.transports.delete(sid);
    };
    await createServer(registration.context).connect(transport);
  }

  if (!transport) {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid MCP session" },
      id: null,
    });
    return;
  }

  try {
    await transport.handleRequest(req, res, body);
  } catch (err: any) {
    console.error(`[Codex MCP] Request failed: ${err.message}`, err.stack);
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP server error" },
        id: null,
      });
    }
  }
}
