/**
 * **The `query` tool** (ADR 0051 §3, design sketch §C.3).
 *
 * One tool whose input *is* the query DSL. Where the generated catalog gives a
 * model seventy tools and asks it to guess which one carries which flag, this
 * gives it one tool and a vocabulary it can read: pick a `metric`, bound it with
 * a `range`, narrow it with that metric's filters, cap it, and choose the result
 * envelope.
 *
 * The canned per-metric tools stay — they are excellent for discovery, and a
 * small model does better with a narrow, obvious tool than with a schema it has
 * to compose. `query` is what the prompts and skills recommend once a question
 * needs a filter the canned tool does not expose.
 *
 * ## Why it is a `GET`
 *
 * The collector serves the DSL on both `POST /api/v1/query` and
 * `GET /api/v1/query?q=<url-encoded JSON>`. This tool uses the GET form, so
 * {@link import("./client.js").CollectorClient} stays what it has always been —
 * a read-only client that performs `GET` and nothing else. That is not a
 * cosmetic preference: the client's inability to send anything but a `GET` is
 * one of the reasons an Uptimizr agent is structurally incapable of writing
 * (ADR 0003 / ADR 0017), and adding a `post()` for one tool would spend that
 * guarantee to save a URL-encode. The collector's 8 KiB cap on `q` is well above
 * any real query — the largest is a twenty-step funnel.
 */

import { z } from "zod";
import { queryV1Schema } from "@uptimizr/schema";
import { allMetrics } from "@uptimizr/metrics";
import type { ReadTool, ReadToolRequest } from "./tools.js";

/** The tool name, also the `operationId` of the endpoint it calls. */
export const QUERY_TOOL_NAME = "query";

/** The collector path the tool reads, root-relative like every other tool's. */
const QUERY_PATH = "api/v1/query";

/**
 * The agent-facing description.
 *
 * It says six things a model needs and cannot infer from a JSON Schema: where
 * the metric vocabulary comes from (so it looks an id up rather than inventing
 * one), that `range` is not optional, how to read the default envelope, that
 * `compare` will do the arithmetic it would otherwise do in prose, that
 * `explain` exists at all, and that a summary row already carries the query to
 * drill into it. The last three are the ones a model never discovers on its own:
 * it will subtract two results by hand, report a zero it cannot account for, and
 * rebuild a filter it was handed — every time — unless the tool says otherwise.
 */
function describeQueryTool(): string {
  const known = new Set(allMetrics().map((metric) => metric.id as string));
  const examples = ["top_meshes", "perf_summary", "mesh_sources", "timeseries"]
    .filter((id) => known.has(id))
    .map((id) => `\`${id}\``)
    .join(", ");
  return (
    "Run any Uptimizr metric in one validated request: choose the `metric`, bound it with a " +
    "`range` (required, epoch milliseconds), narrow it with the filters that metric declares, " +
    "cap it with `limit`, and choose the result envelope with `format`.\n\n" +
    "Metric ids come from the registry — read the `uptimizr://capabilities` resource (or the " +
    "collector's `GET /api/v1/openapi.json`) for the full list, which also names each metric's " +
    `filters, its row columns and their units. Examples: ${examples}.\n\n` +
    'How to read it: the default `format: "table"` returns `{ meta, rows }`, where `meta` ' +
    "carries the window, the filters that were applied, the sample size behind the answer and " +
    "whether the result was truncated — read it before quoting a number. `summary` returns a " +
    "bounded digest (top rows, a trend, or merged spatial clusters) with shares and a " +
    "plain-language reading; prefer it for a heatmap or a long leaderboard. `full` returns the " +
    "bare rows.\n\n" +
    "What changed: set `compare` to another `{ range }` or `{ segment }` and the result comes " +
    "back already joined on the dimension key — `{ current, previous, delta, deltaPct }` per " +
    "row, with a significance test where the measure is a count and both windows are big " +
    "enough. Never run two queries and subtract them yourself.\n\n" +
    "Can you trust it: set `explain: true` and the response is the plan instead of the rows — " +
    "which compiler would run, the SQL with its parameters left unbound, how much data the " +
    "window holds, and every reason the answer might mislead (a capture channel that is " +
    "switched off, a sample below the metric's own minimum, a result cut off by `limit`). Worth " +
    "one call before reporting a zero.\n\n" +
    "Narrowing down: every row of a `summary` carries `drillQuery` — the whole query, narrowed " +
    "to that row, ready to send straight back. Use it rather than rebuilding the query.\n\n" +
    "Caveats:\n" +
    "- Naming a metric, dimension or filter that does not exist is an error that names what the " +
    "metric does accept — read it rather than guessing again.\n" +
    "- `dimensions` may be any subset a metric declares **when** its measure is a portable count " +
    "(event counts, mesh and interaction tallies, input actions, camera gestures). A spatial " +
    "heatmap or a percentile is computed at one fixed grain and refuses anything else by name.\n" +
    "- `order` takes a measure column, not a label, and only where the result is a ranked list."
  );
}

/**
 * The `{ result }` envelope the tool advertises.
 *
 * The per-metric tools always return `{ rows }`, because their result is always
 * a list of one metric's rows. This tool's shape is chosen by `format`, and the
 * three envelopes are defined once in `@uptimizr/db/summary` — a package this
 * one must not depend on, because it ships a DuckDB driver. Restating two
 * hundred lines of envelope schema here to dodge that dependency would create
 * exactly the second definition ADR 0051 §1 exists to prevent, and an MCP client
 * validating against a stale copy would reject a perfectly good answer.
 *
 * So the advertised schema is one described key, and the **response describes
 * itself**: a `table` carries `meta.metric`, `meta.sampleSize` and
 * `meta.truncated`; a `summary` carries `kind`, `metric`, `measure`, `reading`
 * and `caveats`.
 */
const outputSchema = {
  result: z
    .unknown()
    .describe(
      "The result, shaped by `format`: `table` → `{ meta, rows }` (the default), `summary` → a " +
        "bounded digest with `kind`, `reading` and `caveats`, `full` → the bare rows.",
    ),
};

/**
 * The single `query` tool. Its `inputSchema` is the DSL itself, so the model
 * sees the same grammar the collector validates and the docs describe — there is
 * no second, paraphrased tool schema to drift.
 */
export const queryTool: ReadTool = {
  name: QUERY_TOOL_NAME,
  title: "Run an analytics query",
  description: describeQueryTool(),
  inputSchema: queryV1Schema.shape,
  outputSchema,
  buildRequest: (args: Record<string, unknown>): ReadToolRequest => ({
    path: QUERY_PATH,
    params: { q: JSON.stringify(args) },
  }),
  structuredContent: (data: unknown) => ({ result: data }),
};
