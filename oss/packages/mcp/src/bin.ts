#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCollectorClient, type CollectorClient } from "@uptimizr/agent-core";
import { readMcpConfig } from "./config.js";
import { createMcpServer } from "./server.js";

/**
 * Ask the collector what this key may do (`GET /api/v1/whoami`, #309), so a key
 * carrying `query:raw` gets the capability-gated tools and a plain `query` key
 * does not (ADR 0051 §7).
 *
 * Best effort by design: a collector older than the endpoint, an offline start
 * or a transient failure must not stop the server coming up. On any failure the
 * answer is "no extra capabilities", which serves the ordinary `query` surface —
 * exactly the catalog this binary served before capability-gated tools existed.
 */
async function discoverCapabilities(client: CollectorClient): Promise<readonly string[]> {
  try {
    const whoami = (await client.get("api/v1/whoami", {})) as { capabilities?: unknown };
    return Array.isArray(whoami.capabilities)
      ? whoami.capabilities.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Entry point: read configuration from the environment, build a read-only
 * collector client and MCP server, and serve over stdio (the transport MCP
 * clients such as Claude Desktop / VS Code launch).
 */
async function main(): Promise<void> {
  const config = readMcpConfig();
  const client = createCollectorClient(config);
  const capabilities = await discoverCapabilities(client);
  const server = createMcpServer(client, { capabilities });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`uptimizr-mcp failed to start: ${message}\n`);
  process.exit(1);
});
