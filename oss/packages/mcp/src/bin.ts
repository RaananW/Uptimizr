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
  // Ask the collector what this key may do before building the server, so the
  // capability-gated tools match the key: the raw-session tools of #314 only for
  // `query:raw`, the metadata write tools of #310 only for `annotate`. Best
  // effort — a collector older than `/api/v1/whoami`, an offline start or a
  // transient failure yields "no extra capabilities", which serves the ordinary
  // `query` surface this binary has always served.
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
