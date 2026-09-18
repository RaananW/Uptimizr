import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rawTools, readTools, type CollectorClient, type ReadTool } from "@uptimizr/agent-core";
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
 * How to build the server for one session.
 *
 * Deliberately an **options bag** from the start: the collector-hosted transport
 * (#313) builds one server per authenticated MCP session and the metadata-write
 * tools (#310) will key off the same field, so this is the one place a per-key
 * decision is threaded through.
 */
export interface CreateMcpServerOptions {
  /**
   * The capability set of the API key behind the client, as
   * `GET /api/v1/whoami` reports it (`["query", "query:raw", …]`). Unknown
   * values are ignored; omitting the option serves the `query` surface only.
   */
  capabilities?: readonly string[];
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
 *
 * `options.capabilities` is what the **key** behind `client` is allowed to do
 * (`GET /api/v1/whoami`). Tools whose endpoint needs more than the ordinary
 * `query` capability are registered only when the key really holds it, so
 * `tools/list` describes what this session can actually do rather than what the
 * collector could do for somebody else. Omit it and only the `query` surface is
 * served — the safe default for a caller that has not looked the key up.
 */
export function createMcpServer(
  client: CollectorClient,
  options: CreateMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: "uptimizr-mcp", version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // The default is the ordinary read surface, never "nothing": a caller that has
  // not looked the key up still gets every `query` tool, exactly as before.
  const capabilities = options.capabilities ?? ["query"];
  const tools: ReadTool[] = [
    ...readTools,
    // `query:raw` additionally requires `ENABLE_RAW_SESSION_RETENTION` on the
    // collector (ADR 0003), which this process cannot see — a narrative tool on
    // a retention-disabled collector still answers 403, and says so.
    ...(capabilities.includes("query:raw") ? rawTools : []),
  ];

  for (const tool of tools) {
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

  registerResources(server, client, { capabilities });
  registerPrompts(server);

  return server;
}
