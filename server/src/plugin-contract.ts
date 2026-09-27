import { z } from "zod";
import { createSdkMcpServer, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EsmMcpServer } from "./mcp-server-esm.mjs";
import type { SocketAgentPlugin } from "./plugin-api";
import { isRecord } from "./value-guards";

// The Agent SDK bundles its own MCP class. Accept either actual implementation,
// without treating a plain object with a few similarly named methods as a server.
const sdkMcpConstructor = createSdkMcpServer({ name: "plugin-contract", tools: [] }).instance.constructor;
type RuntimeConstructor = abstract new (...args: never[]) => object;
const pluginMcpConstructors = new Set<RuntimeConstructor>();

function isConstructor(value: unknown): value is RuntimeConstructor {
  return typeof value === "function" && isRecord(value.prototype);
}

// Private plugins may bundle another copy of either SDK. Read the constructors
// from their already-loaded dependency graph; do not accept constructor names
// or structural lookalikes supplied by the plugin's return value.
function registerPluginMcpConstructors(file: string): void {
  const root = require.cache[file];
  if (!root) return;
  const visited = new Set<NodeModule>();
  const pending = [root];
  while (pending.length) {
    const dependency = pending.pop();
    if (!dependency || visited.has(dependency)) continue;
    visited.add(dependency);
    pending.push(...dependency.children);
    const filename = dependency.filename.replace(/\\/g, "/");
    const exports: unknown = dependency.exports;
    if (!isRecord(exports)) continue;
    if (/\/@anthropic-ai\/claude-agent-sdk\/sdk\.mjs$/.test(filename) && isHook(exports.createSdkMcpServer)) {
      const sample = exports.createSdkMcpServer({ name: "plugin-contract", tools: [] });
      if (isRecord(sample) && isRecord(sample.instance) && isConstructor(sample.instance.constructor)) {
        pluginMcpConstructors.add(sample.instance.constructor);
      }
    } else if (/\/@modelcontextprotocol\/sdk\/dist\/(?:cjs|esm)\/server\/mcp\.js$/.test(filename) && isConstructor(exports.McpServer)) {
      pluginMcpConstructors.add(exports.McpServer);
    }
  }
}

function isMcpServer(value: unknown): value is McpServer {
  return value instanceof McpServer || value instanceof EsmMcpServer || value instanceof sdkMcpConstructor
    || [...pluginMcpConstructors].some(constructor => value instanceof constructor);
}

const strings = z.record(z.string(), z.string());
const toolPolicy = z.object({
  name: z.string(), permission_policy: z.enum(["always_allow", "always_ask", "always_deny"]).optional(),
  org_max_permission: z.enum(["allow", "ask", "blocked"]).optional(),
}).passthrough();
const remote = {
  url: z.string(), headers: strings.optional(), tools: z.array(toolPolicy).optional(),
  timeout: z.number().optional(), alwaysLoad: z.boolean().optional(),
};
const mcpConfig: z.ZodType<McpServerConfig> = z.union([
  z.object({ type: z.literal("stdio").optional(), command: z.string(), args: z.array(z.string()).optional(),
    env: strings.optional(), timeout: z.number().optional(), alwaysLoad: z.boolean().optional() }).passthrough(),
  z.object({ type: z.literal("http"), ...remote }).passthrough(),
  z.object({ type: z.literal("sse"), ...remote }).passthrough(),
  z.object({ type: z.literal("sdk"), name: z.string(), instance: z.custom<McpServer>(isMcpServer),
    timeout: z.number().optional() }).passthrough(),
]);
const interceptorResult = z.union([
  z.object({ behavior: z.literal("allow"), updatedInput: z.record(z.string(), z.unknown()).optional(), message: z.string().optional() }),
  z.object({ behavior: z.literal("deny"), message: z.string() }), z.null(),
]);
const answerResult = z.union([
  z.object({ handled: z.literal(true), publicAnswers: strings.optional() }),
  z.object({ handled: z.literal(false) }),
]);

function isHook(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function optionalHook(plugin: Record<string, unknown>, name: string) {
  const hook = plugin[name];
  if (hook === undefined) return undefined;
  if (!isHook(hook)) throw new Error(`Plugin ${name} must be a function`);
  return (...args: unknown[]) => hook.apply(plugin, args);
}

/** Validate dynamically loaded exports and every hook result before use. */
export function parseSocketAgentPlugin(module: unknown, loadedFile?: string): SocketAgentPlugin {
  const plugin = isRecord(module) && module.default ? module.default : module;
  if (!isRecord(plugin) || typeof plugin.name !== "string" || !plugin.name.trim()) {
    throw new Error("Plugin must export a named object");
  }
  const init = optionalHook(plugin, "init");
  const cleanup = optionalHook(plugin, "cleanup");
  const httpHandler = optionalHook(plugin, "httpHandler");
  const interceptor = optionalHook(plugin, "canUseToolInterceptor");
  const answer = optionalHook(plugin, "answerMiddleware");
  const authorize = optionalHook(plugin, "requestAuthorization");
  const servers = optionalHook(plugin, "mcpServers");
  if (servers && loadedFile) registerPluginMcpConstructors(loadedFile);
  const allowedTools = optionalHook(plugin, "allowedTools");
  const fragment = optionalHook(plugin, "toolContextFragment");
  const env = optionalHook(plugin, "envVars");
  return {
    name: plugin.name,
    ...(init ? { init: async ctx => { await init(ctx); } } : {}),
    ...(cleanup ? { cleanup: async () => { await cleanup(); } } : {}),
    ...(httpHandler ? { httpHandler: (req, res) => z.boolean().parse(httpHandler(req, res)) } : {}),
    ...(interceptor ? { canUseToolInterceptor: async (tool, input, ctx) => interceptorResult.parse(await interceptor(tool, input, ctx)) } : {}),
    ...(answer ? { answerMiddleware: async (id, answers, ctx) => answerResult.parse(await answer(id, answers, ctx)) } : {}),
    ...(authorize ? { requestAuthorization: async ctx => z.boolean().parse(await authorize(ctx)) } : {}),
    ...(servers ? { mcpServers: () => z.record(z.string(), mcpConfig).parse(servers()) } : {}),
    ...(allowedTools ? { allowedTools: () => z.array(z.string()).parse(allowedTools()) } : {}),
    ...(fragment ? { toolContextFragment: () => z.string().parse(fragment()) } : {}),
    ...(env ? { envVars: () => strings.parse(env()) } : {}),
  };
}
