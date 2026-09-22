import { z } from "zod";
import { LIMITS } from "./limits.js";
import { queryRangeSchema, queryV1Schema } from "./query.js";

/**
 * **Declarative panel specs** (ADR 0051 §7, design sketch §G.3).
 *
 * A `panelSpecV1` is what an agent leaves behind when an answer is worth
 * keeping: a title, the query that produced it, how to draw the result, and the
 * one-line reading that made it worth pinning. The dashboard renders it with
 * the panel components it already ships.
 *
 * ## Why this is data and not a module
 *
 * ADR 0041 loads *remote panel modules* at runtime, and is explicit about what
 * that costs: a remote panel executes with the dashboard's full privileges,
 * which is why it is off by default and guarded by an origin allowlist. A panel
 * an LLM wrote would be exactly that — model-generated code with the operator's
 * API key in scope — so it is not how agent-authored panels work here. A spec is
 * a **closed document**: a metric id, a chart name, some column names. There is
 * no expression to evaluate and no module to import, so pinning a panel widens
 * the dashboard's trust boundary by nothing at all. ADR 0041's decision is left
 * exactly where it is.
 *
 * Like `funnel.ts`, `sceneRegion.ts` and `metadata.ts` this is a **config**
 * contract rather than an analytics event: it is not part of the event union
 * and never reaches the public ingest path. It lives here because both ends of
 * the wire need it — the collector validates it, `@uptimizr/react` renders it,
 * and `@uptimizr/agent-core` advertises it as the input schema of the
 * `pin_panel` tool.
 *
 * ## Shape here, vocabulary in `@uptimizr/metrics`
 *
 * The same split the query DSL makes (see `query.ts`). This file answers "is
 * this a well-formed spec?" — the right types, bounded strings, a known chart
 * name, no unknown keys. It cannot answer "does `line` make sense for
 * `top_meshes`", because that is a question about the metric's *grain*, and the
 * vocabulary lives in a package this one cannot depend on.
 * `validatePanelSpec()` in `@uptimizr/metrics` answers it and returns typed,
 * registry-derived issues. The collector runs both, in that order.
 *
 * ## The stored row is bounded by construction
 *
 * Unlike a saved analysis — whose `query` is an opaque record and therefore
 * needs an explicit cap on its serialized length — a panel spec has no open
 * field. The title, the note and each encoding column are capped here; the
 * query is `queryV1`, whose grammar is closed and every leaf of which is
 * bounded (`QUERY_MAX_DIMENSIONS`, the funnel step cap, each filter's own
 * range). The largest document the grammar admits is a few thousand
 * characters, so there is no separate document-length refinement to add: it
 * could not fire, and a bound that cannot fire misdescribes what protects the
 * row.
 */

/**
 * The chart kinds a spec may ask for — exactly the drawings the OSS panel
 * catalog can already produce, and no more.
 *
 * A closed enum rather than an open string is the whole point: a chart name
 * that is not in this list is a spec the dashboard could not draw, and it is
 * better to hear that from the collector at pin time than to see an empty panel
 * a week later.
 *
 * - `stat` — one number, big. For a metric whose result *is* one row.
 * - `table` — the rows as they came, for anything.
 * - `bar` — a ranked list of labelled bars.
 * - `line` / `area` — a measure walked along an ordered axis.
 * - `heatmap2d` — a binned grid, drawn on the pointer-heatmap canvas.
 * - `world3d` — voxels, drawn in the world-heatmap 3D view.
 */
export const panelChartKindSchema = z.enum([
  "stat",
  "table",
  "bar",
  "line",
  "area",
  "heatmap2d",
  "world3d",
]);
export type PanelChartKind = z.infer<typeof panelChartKindSchema>;

/**
 * The literal a spec's `range` carries when the panel should follow the
 * dashboard's global filter bar rather than pin its own window.
 *
 * This is the normal case, and it is why a pinned panel stays useful: a spec
 * that froze the range it was asked at would answer the same question forever
 * while the grid around it moved. The host substitutes the active window at
 * render time. A spec *may* still pin an explicit `{ since, until }` — a note
 * about one incident is about one window and nothing else — which is why this
 * is a union rather than the only option.
 */
export const PANEL_RANGE_INHERIT = "inherit";

/** `"inherit"`, or an explicit `{ since, until }` window. */
export const panelSpecRangeSchema = z.union([z.literal(PANEL_RANGE_INHERIT), queryRangeSchema]);
export type PanelSpecRange = z.infer<typeof panelSpecRangeSchema>;

/**
 * The spec's query: a `queryV1` document whose `range` may additionally be
 * `"inherit"`.
 *
 * Built by overriding one key of `queryV1Schema` rather than by restating the
 * grammar, so a filter, a dimension cap or a bound added to the DSL reaches
 * panel specs in the same commit. `format` and `explain` are dropped: a panel
 * renders rows, so the envelope is the host's choice, and an `explain` plan is
 * not a chart.
 */
export const panelSpecQuerySchema = queryV1Schema
  .omit({ format: true, explain: true })
  .extend({ range: panelSpecRangeSchema });
export type PanelSpecQuery = z.infer<typeof panelSpecQuerySchema>;

/**
 * Which result column feeds which channel of the chart.
 *
 * Column *names*, not expressions — the whole document stays closed. Every
 * field is optional because a sensible default exists for each chart kind (the
 * metric's label column on `x`, its measure on `y`), and because most charts
 * need only one or two of the three. `validatePanelSpec()` checks that whatever
 * is named is a column the metric actually returns, so a typo is caught at pin
 * time rather than rendering a blank panel a week later.
 */
export const panelEncodingSchema = z
  .object({
    /** The categorical or ordered axis: a mesh name, a scene, a time bucket. */
    x: z.string().min(1).max(LIMITS.maxPanelEncodingColumnLength).optional(),
    /** The measure drawn: a count, a rate, a duration. */
    y: z.string().min(1).max(LIMITS.maxPanelEncodingColumnLength).optional(),
    /** Splits the result into one series per distinct value. */
    series: z.string().min(1).max(LIMITS.maxPanelEncodingColumnLength).optional(),
  })
  .strict();
export type PanelEncoding = z.infer<typeof panelEncodingSchema>;

/**
 * One declarative panel, exactly as a client writes it.
 *
 * ```json
 * {
 *   "v": 1,
 *   "title": "Which meshes people actually touch",
 *   "query": { "v": 1, "metric": "top_meshes", "range": "inherit", "limit": 10 },
 *   "chart": "bar",
 *   "encoding": { "x": "mesh", "y": "count" },
 *   "span": 1,
 *   "note": "The crate outsells everything else three to one."
 * }
 * ```
 */
export const panelSpecV1Schema = z
  .object({
    /** Grammar version. Pinned to `1` so a future shape is a new literal. */
    v: z.literal(1),
    /** What the panel is called in the grid. */
    title: z.string().min(1).max(LIMITS.maxPanelSpecTitleLength),
    /** The question the panel asks, every time it renders. */
    query: panelSpecQuerySchema,
    /** How to draw the answer. */
    chart: panelChartKindSchema,
    /** Which column feeds which channel. Defaults are derived from the metric. */
    encoding: panelEncodingSchema.optional(),
    /** Fixed-grid width, matching the panel contract's `PanelSpan` (ADR 0036). */
    span: z.union([z.literal(1), z.literal(2)]).default(1),
    /**
     * The agent's one-line reading, shown as the panel's subtitle. This is the
     * part a person actually reads a week later, so it is worth writing even
     * though it is optional.
     */
    note: z.string().max(LIMITS.maxPanelSpecNoteLength).optional(),
  })
  .strict();

/** A parsed spec, with `span` defaulted. */
export type PanelSpecV1 = z.infer<typeof panelSpecV1Schema>;

/** A spec exactly as a client writes it, before defaults are applied. */
export type PanelSpecV1Input = z.input<typeof panelSpecV1Schema>;

/**
 * Resolve a spec's `range` against the window the host is currently showing.
 *
 * The one place `"inherit"` becomes a real window, shared by the dashboard
 * renderer and anything else that runs a spec, so the literal cannot come to
 * mean two different things in two places.
 */
export function resolvePanelSpecRange(
  range: PanelSpecRange,
  active: { since: number; until: number },
): { since: number; until: number } {
  return range === PANEL_RANGE_INHERIT ? { since: active.since, until: active.until } : range;
}
