import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  rawTools,
  readTools,
  writeTools,
  type CollectorClient,
  type ReadTool,
} from "@uptimizr/agent-core";
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
function structuredResult(tool: ReadTool, data: unknown, format: unknown): Record<string, unknown> {
  // A generated per-metric tool returns one metric's rows, so the `format`
  // envelope above is the default. The `query` tool (ADR 0051 §3) chooses its
  // own shape — what comes back depends on the `format` that was asked for —
  // so it supplies the wrapper itself.
  const payload =
    tool.structuredContent?.(data) ?? (isEnvelope(data, format) ? data : { rows: toRows(data) });
  const parsed = tool.outputSchema!.safeParse(payload);
  return parsed.success ? (parsed.data as Record<string, unknown>) : payload;
}

/**
 * How to build the server for one session.
 *
 * Deliberately an **options bag**: the collector-hosted transport (#313) builds
 * one server per authenticated MCP session, and both the `query:raw` tools
 * (#314) and the metadata write tools (#310) key off the same field, so this is
 * the one place a per-key decision is threaded through.
 */
export interface CreateMcpServerOptions {
  /**
   * The capability set of the API key this server instance is bound to —
   * `query`, `query:raw`, `annotate`, … (ADR 0051 §7).
   *
   * Supplied by the **collector-hosted** Streamable HTTP transport (`/mcp`),
   * which resolves the key on every request and builds one server per session,
   * so the surface a session sees can match what its key may actually do. The
   * stdio entry point omits it: that process never learns the key's
   * capabilities, and the collector is the enforcement point either way, so an
   * omitted set means "register the read-only catalog and let the collector
   * refuse anything the key may not do".
   *
   * Tools outside the set are simply not registered: the raw-session tools of
   * #314 only for a key holding `query:raw`, the metadata write tools of #310
   * only for one holding `annotate`. Unknown values are ignored, and omitting
   * the option serves the ordinary `query` surface — exactly what every caller
   * written before #310/#313/#314 gets. Deliberately typed as plain strings so
   * this package keeps its dependency-free footprint — it must not reach into
   * `@uptimizr/db` for the capability union (see `__tests__/dependencies.test.ts`).
   */
  capabilities?: readonly string[];
}

/**
 * Server-level `instructions` for a session whose key capabilities are known.
 *
 * Only built when {@link CreateMcpServerOptions.capabilities} is supplied, so
 * the stdio server's `initialize` result stays byte-for-byte what it has always
 * been. Capability names are not secret — `GET /api/v1/whoami` returns the same
 * list to the key's holder — and naming them saves an agent a round of
 * trial-and-error against tools it could never call.
 */
function instructionsFor(capabilities: readonly string[]): string {
  const granted = capabilities.length > 0 ? capabilities.join(", ") : "none";
  return (
    "Every tool here reads one aggregate metric from the connected Uptimizr collector, " +
    "always scoped to the project the API key belongs to — no cross-project access, and no " +
    "personally identifying data. " +
    `The key this session is bound to holds these capabilities: ${granted}. ` +
    "Tools outside that set are not registered, and the collector refuses them independently. " +
    "Read the uptimizr://capabilities resource first: it gives every metric's grain, column " +
    "units, row limits, interpretation and caveats, so a query can be planned rather than guessed."
  );
}

/**
 * Ask the collector what the configured key may do (`GET /api/v1/whoami`).
 *
 * Never throws: an older collector without the route, an unreachable one, or a
 * key that cannot even read all yield an empty capability set, and the server
 * then starts read-only rather than not starting at all. A degraded but useful
 * server beats no server.
 */
export async function fetchKeyCapabilities(client: CollectorClient): Promise<readonly string[]> {
  try {
    const whoami = (await client.get("/api/v1/whoami")) as { capabilities?: unknown } | null;
    return Array.isArray(whoami?.capabilities)
      ? whoami.capabilities.filter(
          (capability): capability is string => typeof capability === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Build the Uptimizr MCP server: an `McpServer` whose tools each wrap one
 * collector endpoint via the injected `CollectorClient`. The server holds no
 * business logic — it forwards validated arguments and returns the collector's
 * JSON (ADR 0005 / ADR 0017). Alongside the tools it exposes
 * capability-discovery **resources** and curated analysis **prompts** so agents
 * can self-orient (ADR 0050 §7).
 *
 * The **analytics** tool catalog is generated from the metric registry
 * (ADR 0051 §1), so `tools/list` covers every metric the collector serves on an
 * endpoint. Each tool advertises the registry-derived `outputSchema` and returns
 * both `structuredContent` — the `format` envelope the call asked for, which
 * since #336 is `{ meta, rows }` by default — and the `content` text a client
 * without structured-output support still reads. That catalog is entirely
 * read-only: **events cannot be written, altered or deleted through this
 * server** (ADR 0051 §9).
 *
 * `options.capabilities` is what the **key** behind `client` is allowed to do
 * (`GET /api/v1/whoami`). Tools whose endpoint needs more than the ordinary
 * `query` capability are registered only when the key really holds it, so
 * `tools/list` describes what this session can actually do rather than what the
 * collector could do for somebody else: the raw-session tools of #314 behind
 * `query:raw`, the **metadata** tools of #310 — annotations, glossary, saved
 * analyses — behind `annotate`. Omit it and only the `query` surface is served,
 * the safe default for a caller that has not looked the key up.
 *
 * The factory is **transport-agnostic**: `bin.ts` connects it to stdio, and the
 * collector connects one instance per authenticated Streamable HTTP session at
 * `/mcp` (ADR 0051 §7), passing that session's key capabilities through
 * `options`. Both get the same tools, resources and prompts from this one place.
 */
export function createMcpServer(
  client: CollectorClient,
  options: CreateMcpServerOptions = {},
): McpServer {
  // The default is the ordinary read surface, never "nothing": a caller that has
  // not looked the key up still gets every `query` tool, exactly as before.
  // `instructions`, by contrast, keys off the *supplied* set, so a stdio server
  // built without one keeps the `initialize` result it has always had.
  const capabilities = options.capabilities ?? ["query"];
  const server = new McpServer(
    { name: "uptimizr-mcp", version },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      ...(options.capabilities ? { instructions: instructionsFor(options.capabilities) } : {}),
    },
  );

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
            structuredContent: structuredResult(tool, data, params.format),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }

  // Metadata tools (#310, ADR 0051 §5): annotations, glossary, saved analyses.
  //
  // They appear in `tools/list` only for a key that holds `annotate`. That is a
  // usability decision, not the security boundary — the collector refuses the
  // write either way with a 403 — but offering an agent a tool it will always
  // be refused for wastes its context and its patience.
  //
  // Nothing here can write, alter or delete an event: the tools call the three
  // metadata endpoints and nothing else, and every call is audited by the
  // collector (ADR 0051 §7/§9).
  if (capabilities.includes("annotate")) {
    for (const tool of writeTools) {
      server.registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
        async (args) => {
          try {
            const data = await tool.execute(client, args as Record<string, unknown>);
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
          }
        },
      );
    }
  }

  registerResources(server, client, { capabilities });
  registerPrompts(server);

  return server;
}
