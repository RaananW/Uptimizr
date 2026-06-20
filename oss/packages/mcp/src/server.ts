import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectorClient } from "./client.js";
import { readTools } from "./tools.js";
import { version } from "./version.js";

/**
 * Build the Uptimizr MCP server: a read-only `McpServer` whose tools each wrap
 * one collector query endpoint via the injected `CollectorClient`. The server
 * holds no business logic — it forwards validated arguments and returns the
 * collector's JSON (ADR 0005 / ADR 0017).
 */
export function createMcpServer(client: CollectorClient): McpServer {
  const server = new McpServer({ name: "uptimizr-mcp", version });

  for (const tool of readTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args) => {
        try {
          const { path, params } = tool.buildRequest(args as Record<string, unknown>);
          const data = await client.get(path, params);
          return { content: [{ type: "text", text: JSON.stringify(data) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }

  return server;
}
