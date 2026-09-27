// MCP publishes separate ESM/CJS classes. Keep the ESM constructor available
// when checking instances supplied by ESM plugins in our CommonJS server.
export { McpServer as EsmMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
