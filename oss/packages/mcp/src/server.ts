import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { readTools, type CollectorClient } from "@uptimizr/agent-core";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { version } from "./version.js";

/**
 * Normalise a collector response into the `{ rows }` envelope a `format=full`
 * result is reported in. Aggregate endpoints already return an array; the
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
 * Whether the collector really answered with the envelope the call asked for:
 * `format=table` with a `meta` block around its rows, `format=summary` with a
 * `kind`-tagged digest and its `reading`. Both keys are required so a *row* that
 * happens to have a `kind` column is never mistaken for a digest.
 */
function isEnvelope(data: unknown, format: unknown): data is Record<string, unknown> {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return false;
  const payload = data as Record<string, unknown>;
  if (format === "table") return "meta" in payload && "rows" in payload;
  if (format === "summary") return "kind" in payload && "reading" in payload;
  return false;
}

/**
 * The structured payload for one tool result: the collector's response in the
 * envelope the call asked for, validated against the tool's registry-derived
 * output schema and returned **parsed**.
 *
 * `format=table` and `format=summary` are returned as they arrive — the whole
 * point of those envelopes is the `meta` / `reading` they carry, and stripping
 * them here is precisely the bug that made the SDK reject the recommended path
 * with `-32602` (#350). `full` keeps the `{ rows }` wrapping it has always had.
 * Which envelope to expect is decided by the `format` the request actually
 * carried — not guessed from the payload — and the payload must then actually
 * *be* that envelope (`meta` + `rows`, or a `kind`-tagged digest). Anything
 * else is wrapped as rows, which is what keeps a modern client working against
 * an **older collector** that does not know `format` and answers a `table`
 * request with the bare rows (or the bare record) it always returned.
 *
 * The registry's numeric columns are strict `z.number()`: since ADR 0051 §2 the
 * *collector* guarantees numbers, coercing each dialect's wire format
 * (ClickHouse's string-encoded 64-bit integers, `pg`'s `int8`) at the single
 * point rows leave its driver. So this is a check, not a repair — the advertised
 * schema describes the API, and normalising here would hide a store regression.
 *
 * If the payload does not match the schema it is passed through unchanged; the
 * SDK's own output validation then reports the offending column by name, which
 * is the honest outcome for a collector that is out of contract.
 */
function structuredResult(
  outputSchema: z.ZodType,
  data: unknown,
  format: unknown,
): Record<string, unknown> {
  const payload = isEnvelope(data, format) ? data : { rows: toRows(data) };
  const parsed = outputSchema.safeParse(payload);
  return parsed.success ? (parsed.data as Record<string, unknown>) : payload;
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
 * both `structuredContent` — the `format` envelope the call asked for, which
 * since #336 is `{ meta, rows }` by default — and the `content` text a client
 * without structured-output support still reads.
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
            structuredContent: structuredResult(tool.outputSchema, data, params.format),
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
