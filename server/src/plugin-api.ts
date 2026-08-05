import { ServerMessage, HistoryEntry } from "./protocol";
import * as http from "http";

export interface PluginClientTransport {
  readonly readyState: number;
  send(data: string): void;
}

/** Context provided to plugins at init time (server-level state) */
export interface PluginContext {
  getActiveSessions: () => Map<string, any>;
  getConnectedClients: () => Set<PluginClientTransport>;
  /** Broadcast a message to all connected clients (direct + relay) */
  broadcast: (msg: string) => void;
  getPort: () => number;
  getDefaultCwd: () => string;
}

/** Context provided per-session (passed to canUseTool interceptors, answer middleware, etc.) */
export interface SessionContext {
  sessionId: string;
  cwd: string;
  send: (msg: ServerMessage | Record<string, any>) => void;
  /** Persist a message to session history (survives reconnects/restarts) */
  appendHistory: (entry: HistoryEntry) => void;
  pendingQuestions: Map<string, { questionId: string; resolve: (answers: Record<string, string>) => void }>;
  questionCounter: { next: () => string };
}

/** canUseTool interceptor result — return null to pass to next handler */
export type CanUseToolResult =
  | { behavior: "allow"; updatedInput?: any; message?: string }
  | { behavior: "deny"; message: string }
  | null;

/** Answer middleware result */
export type AnswerResult =
  | {
      handled: true;
      /**
       * Optional sanitized values that are safe to show in the app and retain
       * in ordinary question history. Raw plugin answers are private by
       * default and must never be echoed or persisted implicitly.
       */
      publicAnswers?: Record<string, string>;
    }
  | { handled: false };

export interface SocketAgentPlugin {
  name: string;

  /** Called once at server startup */
  init?(ctx: PluginContext): void | Promise<void>;

  /** Called on server shutdown */
  cleanup?(): void | Promise<void>;

  /** Handle HTTP requests. Return true if handled, false to pass through. */
  httpHandler?(req: http.IncomingMessage, res: http.ServerResponse): boolean;

  /** canUseTool interceptor — called before built-in handlers. Return null to pass through. */
  canUseToolInterceptor?(
    toolName: string,
    input: Record<string, any>,
    sessionCtx: SessionContext
  ): Promise<CanUseToolResult>;

  /** Answer middleware — called before default question resolution */
  answerMiddleware?(
    questionId: string,
    answers: Record<string, string>,
    sessionCtx: SessionContext
  ): AnswerResult | Promise<AnswerResult>;

  /**
   * Present a plugin-owned protected authorization flow for this session.
   * This lets harnesses without in-process plugin MCP support request the
   * same card without relying on a shell-command approval side effect.
   */
  requestAuthorization?(sessionCtx: SessionContext): boolean | Promise<boolean>;

  /** Additional MCP servers to register with the SDK */
  mcpServers?(): Record<string, any>;

  /** Additional tool patterns to allow (e.g. ["mcp__my-tools__*"]) */
  allowedTools?(): string[];

  /** Tool context prompt fragment (appended to base prompt on first message) */
  toolContextFragment?(): string;

  /** Extra environment variables to inject into SDK queries */
  envVars?(): Record<string, string>;
}
