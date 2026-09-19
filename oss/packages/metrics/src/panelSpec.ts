/**
 * **Registry validation for declarative panel specs** (ADR 0051 §7, sketch §G.3).
 *
 * The same split the query DSL makes, one level up. `@uptimizr/schema`'s
 * `panelSpecV1Schema` answers "is this a well-formed spec?" — a known chart
 * name, bounded strings, a closed query grammar. It cannot answer the question
 * that actually decides whether the panel will *draw anything*: does this chart
 * suit this metric's grain, and do these encoding columns exist in its result.
 * Those are questions about the vocabulary, and the vocabulary is this package.
 *
 * So {@link validatePanelSpec} runs `validateQuery` over the spec's query and
 * then adds the two checks only the registry can make. It returns objections as
 * data in exactly the {@link QueryIssue} shape the DSL already uses, so the
 * collector turns a bad spec into one `400` with the same body a bad query
 * gets, and a test can assert on codes rather than prose.
 *
 * ## Why the chart is checked at all
 *
 * Because a pinned panel is read much later than it is written. A `line` over
 * `top_meshes` is not a crash — it is a chart with no axis to walk along, which
 * renders as *something*, and a week later somebody reads that something as a
 * trend. Refusing it at pin time is the only moment anybody is paying attention.
 *
 * ## The compatibility rules, in words
 *
 * - `table` — every metric. Rows are rows; this is the honest fallback and the
 *   reason no metric is unpinnable.
 * - `stat` — a metric whose result *is* one row: `project` grain with nothing
 *   keying the rows. One number, big. A `stat` over a ranked list would show
 *   the first row and silently hide the rest.
 * - `bar` — a label to name each bar and a measure to size it, over a grain
 *   that is a *list* rather than a grid: the ranked grains (`mesh`, `scene`,
 *   `session`, `row`) plus `bucket`, which is what a histogram or a funnel
 *   already is. A spatial grid's key is a coordinate, and bars of coordinates
 *   say nothing.
 * - `line` / `area` — an **ordered axis** to walk along: a column the registry
 *   marks `axis`, which it guarantees is exactly the `bucket`-grain metrics
 *   (`registry.test.ts` pins that). Everything else has an order chosen by the
 *   query, and a line drawn through a ranking is a lie about continuity.
 * - `heatmap2d` — a `bin` grain: the metric already bins its input into a grid,
 *   which is the only thing the 2D heatmap canvas can paint.
 * - `world3d` — a `voxel` grain, for the same reason in three dimensions.
 */

import type { PanelChartKind, PanelSpecV1, QueryV1 } from "@uptimizr/schema";
import {
  getMetric,
  type DimensionId,
  type MetricDefinition,
  type MetricGrain,
  type MetricId,
} from "./registry.js";
import {
  dimensionColumn,
  nativeDimensions,
  queryTier,
  validateQuery,
  type QueryIssue,
  type QueryTier,
} from "./query.js";

/**
 * Grains whose result is a **list of named things** — the shapes a bar chart
 * can rank. Deliberately the same set the DSL calls orderable, plus `bucket`:
 * a histogram, a funnel and a daily count are all drawn as bars, and the DSL
 * excludes `bucket` from *reordering* for a different reason (its order is the
 * axis, and re-sorting it would destroy the thing being shown).
 */
const BAR_GRAINS: ReadonlySet<MetricGrain> = new Set<MetricGrain>([
  "mesh",
  "scene",
  "session",
  "row",
  "bucket",
]);

/** Why a panel spec was rejected. Extends the DSL's codes rather than replacing them. */
export type PanelSpecIssueCode =
  /** The `chart` cannot draw this metric's grain. */
  | "chart_grain_mismatch"
  /** An `encoding` column the metric's result does not contain. */
  | "unknown_encoding_column";

/** One objection to a panel spec: a DSL issue, or one of the two above. */
export type PanelSpecIssue = Omit<QueryIssue, "code"> & {
  code: QueryIssue["code"] | PanelSpecIssueCode;
};

/** The outcome of validating a panel spec against the registry. */
export interface PanelSpecValidation {
  /** Empty when the spec can be stored and rendered. */
  issues: readonly PanelSpecIssue[];
  /** The resolved metric, when the spec's query named one it could compile. */
  metric?: MetricDefinition;
  /** The tier the spec's query runs on, when it resolved. */
  tier?: QueryTier;
}

/**
 * One row of the chart/grain compatibility table: which chart, what it needs,
 * and the predicate that decides it.
 *
 * Declared as data rather than as a `switch` so the docs table, the validator
 * and the `suggestChart` fallback all read from one place. `docs/` renders
 * {@link PANEL_CHART_RULES} and `src/__tests__/panelSpec.test.ts` pins the
 * rendering, so the published table cannot drift from the code that enforces it.
 */
export interface PanelChartRule {
  chart: PanelChartKind;
  /** What the chart needs from the metric, in words, for the error and the docs. */
  requires: string;
  /** Whether this metric can be drawn this way. */
  accepts: (metric: MetricDefinition) => boolean;
}

/** Whether the metric's result is a single record rather than a list of rows. */
function isSingleRecord(metric: MetricDefinition): boolean {
  return metric.grain === "project" && nativeDimensions(metric).length === 0;
}

/** The metric's ordered axis column, when it has one (only `bucket` grains do). */
export function axisColumn(metric: MetricDefinition): string | undefined {
  return Object.entries(metric.columns).find(([, semantics]) => semantics.axis === true)?.[0];
}

/** The metric's row-naming column, when it has one. */
export function labelColumn(metric: MetricDefinition): string | undefined {
  return Object.entries(metric.columns).find(([, semantics]) => semantics.label === true)?.[0];
}

/** The metric's headline measure column, when it has one. */
export function measureColumn(metric: MetricDefinition): string | undefined {
  return Object.entries(metric.columns).find(([, semantics]) => semantics.measure === true)?.[0];
}

/**
 * The chart/grain compatibility table. The single source of truth for the
 * validator, the docs and the `suggestChart` fallback.
 */
export const PANEL_CHART_RULES: readonly PanelChartRule[] = [
  {
    chart: "table",
    requires: "nothing — any metric's rows can be listed",
    accepts: () => true,
  },
  {
    chart: "stat",
    requires: "a single-record result (a `project`-grain metric with no grain dimensions)",
    accepts: isSingleRecord,
  },
  {
    chart: "bar",
    requires:
      "a label column, a measure column, and a ranked or bucketed grain " +
      "(`mesh`, `scene`, `session`, `row`, `bucket`)",
    accepts: (metric) =>
      BAR_GRAINS.has(metric.grain) && labelColumn(metric) != null && measureColumn(metric) != null,
  },
  {
    chart: "line",
    requires: "an ordered axis column — in practice a `bucket`-grain metric",
    accepts: (metric) => axisColumn(metric) != null,
  },
  {
    chart: "area",
    requires: "an ordered axis column — in practice a `bucket`-grain metric",
    accepts: (metric) => axisColumn(metric) != null,
  },
  {
    chart: "heatmap2d",
    requires: "a `bin` grain (the metric already bins its input into a grid)",
    accepts: (metric) => metric.grain === "bin",
  },
  {
    chart: "world3d",
    requires: "a `voxel` grain (the metric already bins its input into world-space cells)",
    accepts: (metric) => metric.grain === "voxel",
  },
];

const RULE_BY_CHART = new Map<PanelChartKind, PanelChartRule>(
  PANEL_CHART_RULES.map((rule) => [rule.chart, rule]),
);

/** Whether `chart` can draw `metric`. The predicate behind the table above. */
export function chartSuitsMetric(chart: PanelChartKind, metric: MetricDefinition): boolean {
  return RULE_BY_CHART.get(chart)?.accepts(metric) ?? false;
}

/** Every chart that can draw this metric, in the table's order. */
export function chartsForMetric(metric: MetricDefinition): readonly PanelChartKind[] {
  return PANEL_CHART_RULES.filter((rule) => rule.accepts(metric)).map((rule) => rule.chart);
}

/**
 * The columns one row of this query's result carries.
 *
 * On the delegated tier that is the metric's declared `row` shape, unchanged —
 * the canned builder runs and returns exactly what it always did. On the
 * generic tier the builder projects the grouped dimensions plus the metric's
 * declared measures instead, so the encoding has to be checked against *those*:
 * a regrouped `top_meshes` has no `mesh` column when it was grouped by `source`.
 */
export function resultColumns(metric: MetricDefinition, query: QueryV1): readonly string[] {
  const tier = queryTier(metric, query);
  if (tier === "delegated") return Object.keys(metric.row.shape);
  // `query.dimensions` is bounded-identifier-typed by the schema (the grammar
  // cannot know the registry's union); `validateQuery` has already rejected any
  // that is not one of the metric's declared dimensions by the time a caller
  // reaches here through `validatePanelSpec`.
  const dimensions =
    (query.dimensions as readonly DimensionId[] | undefined) ?? nativeDimensions(metric);
  const grouped = dimensions.map((dimension) => dimensionColumn(metric, dimension));
  const measures = (metric.genericGroupBy?.measures ?? []).map((measure) => measure.column);
  return [...new Set([...grouped, ...measures])];
}

/** `` `a`, `b` `` — for a message listing what would have been accepted. */
function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map((value) => `\`${value}\``).join(", ");
}

/**
 * The query a spec runs, as a `queryV1` the DSL validator understands.
 *
 * `range: "inherit"` is the host's business, not the registry's: whichever
 * window is substituted, it is a window, and nothing `validateQuery` checks
 * depends on which. Substituting a placeholder here keeps the spec validator
 * from needing its own copy of the DSL's rules.
 */
function asQuery(spec: PanelSpecV1): QueryV1 {
  const { range, ...rest } = spec.query;
  return {
    ...rest,
    range: range === "inherit" ? { since: 0, until: 1 } : range,
    // The two keys the spec grammar drops, restored at their DSL defaults so the
    // document `validateQuery` sees is a complete one.
    format: "full",
    explain: false,
  };
}

/**
 * Check a structurally-valid panel spec against the registry.
 *
 * Runs the DSL's own validation first — a spec whose query cannot be answered
 * is not a panel, whatever chart it asks for — and stops there if the metric
 * did not resolve, because every remaining check is about that metric. Chart
 * and encoding objections are then collected together, so an agent that got
 * both wrong learns both in one round trip.
 */
export function validatePanelSpec(spec: PanelSpecV1): PanelSpecValidation {
  const query = asQuery(spec);
  const { issues: queryIssues, metric, tier } = validateQuery(query);
  const issues: PanelSpecIssue[] = queryIssues.map((issue) => ({
    ...issue,
    path: `query.${issue.path}`,
  }));
  if (!metric || tier == null) return { issues };

  // --- chart vs grain -----------------------------------------------------
  if (!chartSuitsMetric(spec.chart, metric)) {
    const rule = RULE_BY_CHART.get(spec.chart);
    const alternatives = chartsForMetric(metric);
    issues.push({
      code: "chart_grain_mismatch",
      path: "chart",
      message:
        `"${metric.id}" cannot be drawn as a ${spec.chart}: that chart needs ${rule?.requires ?? "something this metric does not have"}, ` +
        `and this metric's rows are one per ${metric.grain}. Draw it as ${list([...alternatives])}.`,
      accepted: [...alternatives],
    });
  }

  // --- encoding vs the result's columns -----------------------------------
  const columns = resultColumns(metric, query);
  const columnSet = new Set(columns);
  for (const [channel, column] of Object.entries(spec.encoding ?? {})) {
    if (column == null || columnSet.has(column)) continue;
    issues.push({
      code: "unknown_encoding_column",
      path: `encoding.${channel}`,
      message: `"${metric.id}" returns no column "${column}"${
        tier === "generic" ? " when grouped this way" : ""
      }. Its result columns are ${list(columns)}.`,
      accepted: columns,
    });
  }

  return { issues, metric, tier };
}

/**
 * The chart to pre-fill when an agent pins an answer it just computed.
 *
 * Pure, registry-only and deliberately unambitious: it reads the grain and
 * picks the drawing that grain *is*. A voxelised metric is a world heatmap, a
 * binned one is a 2D heatmap, a bucketed one is a line, a single record is a
 * stat, a ranked list is bars — and anything left over is a table, which can
 * always be drawn. The result always satisfies {@link chartSuitsMetric}, so the
 * assistant's "Pin as panel" never proposes a spec the collector would refuse.
 *
 * `query` is taken so a *regrouped* metric is suggested on the shape it will
 * actually return: `top_meshes` grouped by `source` is still a ranked list, but
 * a generic-tier query that drops the metric's own label column should not be
 * offered a bar it cannot name.
 */
export function suggestChart(metric: MetricDefinition | MetricId, query: QueryV1): PanelChartKind {
  const resolved = typeof metric === "string" ? getMetric(metric) : metric;
  if (resolved == null) return "table";
  const columns = new Set(resultColumns(resolved, query));
  const preference: readonly PanelChartKind[] = [
    "world3d",
    "heatmap2d",
    "stat",
    "line",
    "bar",
    "table",
  ];
  for (const chart of preference) {
    if (!chartSuitsMetric(chart, resolved)) continue;
    // A generic-tier regrouping can project away the very column the chart
    // would have been drawn from, so the suggestion is checked against the
    // columns the query really returns rather than against the metric's own.
    if (chart === "bar") {
      const label = labelColumn(resolved);
      const measure = measureColumn(resolved);
      if (label == null || measure == null) continue;
      if (!columns.has(label) || !columns.has(measure)) continue;
    }
    if (chart === "line") {
      const axis = axisColumn(resolved);
      if (axis == null || !columns.has(axis)) continue;
    }
    return chart;
  }
  return "table";
}

/**
 * The default encoding for a chart over a metric: the metric's own axis or
 * label on `x`, its headline measure on `y`.
 *
 * Shared by the assistant's pre-fill and by the renderer's fallback when a spec
 * carries no `encoding` at all, so "what does this panel draw when nobody said"
 * has exactly one answer.
 */
export function defaultEncoding(
  metric: MetricDefinition,
  chart: PanelChartKind,
): { x?: string; y?: string } {
  const measure = measureColumn(metric);
  const x =
    chart === "line" || chart === "area"
      ? (axisColumn(metric) ?? labelColumn(metric))
      : labelColumn(metric);
  return {
    ...(x != null ? { x } : {}),
    ...(measure != null ? { y: measure } : {}),
  };
}
