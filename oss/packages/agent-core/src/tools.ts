import type { z } from "zod";
import { allMetrics, metricCapability } from "@uptimizr/metrics";
import type { QueryParams } from "./client.js";
import { registryToTools } from "./registryTools.js";
import { queryTool } from "./queryTool.js";

/** A resolved read request: the collector path and its query parameters. */
export interface ReadToolRequest {
  path: string;
  params: QueryParams;
}

/**
 * A read-only tool definition. `inputSchema` is a Zod raw shape the MCP runtime
 * uses to validate arguments; `buildRequest` maps validated arguments to a
 * `GET` against the collector. Definitions are pure and unit-testable without a
 * live collector.
 */
export interface ReadTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /**
   * Zod schema describing what the tool **returns**, derived from the metric
   * registry's `row` schema (ADR 0051 §1) and the `format` result envelope
   * (ADR 0051 §2).
   *
   * It is a single **object** schema, because that is what an MCP
   * `outputSchema` must be. For a metric that honours `format` it is
   * `structuredEnvelopeSchema(row)`: the merged, every-key-optional object form
   * of the three envelopes — `{ rows }` for `full`, `{ meta, rows }` for
   * `table`, the `kind`-tagged digest for `summary` — so a client validating
   * `structuredContent` accepts whichever one the collector returns (#350). The
   * two resource metrics, which declare no `format`, keep the single-key
   * `{ rows: Row[] }` envelope: a single-object result (a session descriptor) is
   * reported as a one-element array so every tool has the same shape.
   *
   * Consumers that speak MCP register it as the tool's `outputSchema`;
   * consumers that do not can ignore it. Optional so a hand-built tool stays
   * valid.
   */
  outputSchema?: z.ZodType;
  /**
   * Turn the collector's response into the object {@link outputSchema}
   * describes. Omitted by every generated per-metric tool, whose result is
   * always a list of rows and is therefore wrapped as `{ rows }` by the
   * consumer. The `query` tool sets it because its shape is chosen by the
   * request's `format`, so only the tool knows how its answer is keyed.
   */
  structuredContent?: (data: unknown) => Record<string, unknown>;
  buildRequest: (args: Record<string, unknown>) => ReadToolRequest;
}

/**
 * The catalog of read-only tools — one per metric in the `@uptimizr/db`
 * **semantic metric registry** that the collector serves on an endpoint
 * (ADR 0051 §1, design sketch §A.2). It is **generated**, not hand-written: a
 * new aggregation reaches agents by getting a registry entry, and there is no
 * second list to keep in step. See `registryTools.ts` for how each field is
 * derived.
 *
 * Every tool wraps one documented collector query endpoint (docs/integration.md
 * §Query). There are intentionally **no** ingestion, mutation, or raw
 * per-session event tools — the surface is aggregate, read-only, and
 * privacy-preserving (ADR 0003 / ADR 0017); the registry's two builder-less
 * resource entries (`session_meta`, `scene_representation`) are coarse
 * descriptors, never an event stream.
 *
 * This is the **`query`** surface: every metric whose endpoint needs nothing
 * more than the ordinary read capability. Metrics that require more are not
 * silently mixed in — see {@link rawTools}.
 *
 * The 20 tool names the hand-written catalog shipped are registry ids verbatim
 * and their argument schemas are unchanged — `__tests__/shippedToolCompat.test.ts`
 * pins that against a frozen fixture, so an MCP client written against the old
 * catalog keeps working.
 *
 * One tool is **not** per-metric: `query` (ADR 0051 §3), appended last. Its
 * input is the query DSL, so it can run any metric with any filter that metric
 * declares — what the per-metric tools are for discovery, `query` is for
 * anything that needs a filter the canned tool does not expose. See
 * `queryTool.ts`.
 */
export const readTools: readonly ReadTool[] = [
  ...registryToTools(allMetrics().filter((metric) => metricCapability(metric) === "query")),
  queryTool,
];

/**
 * The **`query:raw`** tools: generated from exactly the registry metrics whose
 * endpoint declares that capability (ADR 0051 §7, design sketch §G.2). Today
 * that is `session_narrative`, the compacted account of one session.
 *
 * Kept as a separate catalog rather than folded into {@link readTools} because
 * the capability is not a property of the *agent*, it is a property of the **key
 * the agent was handed**. A host registers these tools only after confirming the
 * key holds `query:raw` — `@uptimizr/mcp`'s `createMcpServer(client, {
 * capabilities })` does exactly that, and `GET /api/v1/whoami` is where the
 * capability set comes from. Registering them unconditionally would advertise a
 * tool that answers 403, which is worse for a model than not having it: it burns
 * a turn and invites a retry.
 *
 * The collector refuses these endpoints unless it *also* has
 * `ENABLE_RAW_SESSION_RETENTION` enabled, so holding the capability is necessary
 * but never sufficient (ADR 0003).
 */
export const rawTools: readonly ReadTool[] = registryToTools(
  allMetrics().filter((metric) => metricCapability(metric) === "query:raw"),
);

/**
 * Names of the **core** read tools — a small, single-step-friendly subset of
 * {@link readTools} for small local models (ADR 0050). A 4-bit 7–8B model folds
 * every tool schema into its function-calling system prompt, so sending the
 * whole catalog overwhelms it and degrades selection even for simple questions.
 * This subset covers the most common single-metric questions (recent sessions,
 * active scenes, top meshes, FPS, event counts, event volume over time, and one
 * view-direction heatmap).
 *
 * Plain string membership only — used to FILTER {@link readTools} below, never to
 * redefine any tool shape (schema lives once; ADR).
 */
export const CORE_READ_TOOL_NAMES: readonly string[] = [
  "list_sessions",
  "list_scenes",
  "top_meshes",
  "perf_summary",
  "event_counts",
  "timeseries",
  "camera_heatmap",
];

/**
 * The core read tools: a FILTERED VIEW of {@link readTools} (never a
 * re-declaration), preserving each tool's single source-of-truth definition.
 */
export const coreReadTools: readonly ReadTool[] = readTools.filter((tool) =>
  CORE_READ_TOOL_NAMES.includes(tool.name),
);

/** Which read-tool surface to expose to the model. */
export type ReadToolSetKind = "core" | "full";

/**
 * Select the read-tool set to hand a run. Small local models get the focused
 * {@link coreReadTools}; frontier hosted models get the {@link readTools} full
 * catalog. Both are views of the same single tool definitions.
 */
export function selectReadTools(kind: ReadToolSetKind): readonly ReadTool[] {
  return kind === "core" ? coreReadTools : readTools;
}

/**
 * Narrow the catalog to a caller-supplied set of tool names, preserving catalog
 * order and identity. Unknown names are ignored, so a host app that pins a tool
 * list cannot break when the registry renames or retires a metric — check the
 * result's length if that matters to you.
 *
 * Use it when a model's context budget or a product decision calls for a
 * deliberate subset (see {@link coreReadTools} for the built-in small-model one)
 * rather than the full ~69-tool surface.
 */
export function filterReadTools(names: readonly string[]): readonly ReadTool[] {
  const wanted = new Set(names);
  return readTools.filter((tool) => wanted.has(tool.name));
}
