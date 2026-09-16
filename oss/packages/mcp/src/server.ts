import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTools, type CollectorClient } from "@uptimizr/agent-core";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { version } from "./version.js";

/**
 * Normalise a collector response into the `{ rows }` envelope every tool's
 * `outputSchema` declares. Aggregate endpoints already return an array; the
 * single-object reads (a session descriptor, a scene representation, a one-row
 * summary) become a one-element array so a client can treat every tool's
 * structured result the same way. A `204`-style empty body becomes no rows.
 */
function toRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data == null) return [];
  return [data];
}

/**
 * Validate the rows against the tool's registry-derived output schema and
 * return the **parsed** result as the structured payload.
 *
 * The registry's numeric columns are strict `z.number()`: since ADR 0051 §2 the
 * *collector* guarantees numbers, coercing each dialect's wire format
 * (ClickHouse's string-encoded 64-bit integers, `pg`'s `int8`) at the single
 * point rows leave its driver. So this is a check, not a repair — the advertised
 * schema describes the API, and normalising here would hide a store regression.
 *
 * If the rows do not match the schema the raw rows are passed through; the SDK's
 * own output validation then reports the offending column by name, which is the
 * honest outcome for a collector that is out of contract.
 */
function structuredRows(outputSchema: z.ZodRawShape, data: unknown): { rows: unknown[] } {
  const rows = toRows(data);
  const parsed = z.object(outputSchema).safeParse({ rows });
  return parsed.success ? (parsed.data as { rows: unknown[] }) : { rows };
}

/**
 * Build the Uptimizr MCP server: a read-only `McpServer` whose tools each wrap
 * one collector query endpoint via the injected `CollectorClient`. The server
 * holds no business logic — it forwards validated arguments and returns the
 * collector's JSON (ADR 0005 / ADR 0017). Alongside the tools it exposes
 * capability-discovery **resources** and curated analysis **prompts** so agents
 * can self-orient (ADR 0050 §7).
 *
 * The tool catalog is generated from the `@uptimizr/db` metric registry
 * (ADR 0051 §1), so `tools/list` covers every metric the collector serves on an
 * endpoint. Each tool advertises the registry-derived `outputSchema` and returns
 * both `structuredContent` (the typed `{ rows }` envelope) and the `content`
 * text a client without structured-output support still reads.
 */
export function createMcpServer(client: CollectorClient): McpServer {
  const server = new McpServer(
    { name: "uptimizr-mcp", version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  for (const tool of readTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      },
      async (args) => {
        try {
          const { path, params } = tool.buildRequest(args as Record<string, unknown>);
          const data = await client.get(path, params);
          const text = JSON.stringify(data);
          if (!tool.outputSchema) return { content: [{ type: "text", text }] };
          return {
            content: [{ type: "text", text }],
            structuredContent: structuredRows(tool.outputSchema, data),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }

  registerResources(server, client);
  registerPrompts(server);

  return server;
}
