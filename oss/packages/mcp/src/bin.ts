#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCollectorClient } from "./client.js";
import { readMcpConfig } from "./config.js";
import { createMcpServer } from "./server.js";

/**
 * Entry point: read configuration from the environment, build a read-only
 * collector client and MCP server, and serve over stdio (the transport MCP
 * clients such as Claude Desktop / VS Code launch).
 */
async function main(): Promise<void> {
  const config = readMcpConfig();
  const client = createCollectorClient(config);
  const server = createMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`uptimizr-mcp failed to start: ${message}\n`);
  process.exit(1);
});
