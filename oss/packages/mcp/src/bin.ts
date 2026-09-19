#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCollectorClient } from "@uptimizr/agent-core";
import { readMcpConfig } from "./config.js";
import { createMcpServer, fetchKeyCapabilities } from "./server.js";

/**
 * Entry point: read configuration from the environment, build a read-only
 * collector client and MCP server, and serve over stdio (the transport MCP
 * clients such as Claude Desktop / VS Code launch).
 */
async function main(): Promise<void> {
  const config = readMcpConfig();
  const client = createCollectorClient(config);
  // Ask the collector what this key may do before building the server: the
  // metadata write tools of #310 are registered only for a key that holds
  // `annotate`, so a read-only key never sees a tool it would be refused for.
  const capabilities = await fetchKeyCapabilities(client);
  const server = createMcpServer(client, { capabilities });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`uptimizr-mcp failed to start: ${message}\n`);
  process.exit(1);
});
