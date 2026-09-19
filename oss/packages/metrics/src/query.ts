/**
 * **Registry validation for the query DSL** (ADR 0051 §3, design sketch §C.1).
 *
 * `@uptimizr/schema`'s `queryV1Schema` answers "is this a well-formed query?" —
 * the right types, bounded strings, no unknown keys, no free-form expression.
 * It cannot answer "is `mesh_sources` a metric, does it accept a `cameraMode`
 * filter, and is `limit: 900` within its cap", because those are questions about
 * the **vocabulary**, and the vocabulary is this package. (`@uptimizr/schema`
 * also cannot ask them: it is this package's dependency, not the other way
 * round.)
 *
 * So the split is: shape at the edge, vocabulary here. {@link validateQuery}
 * takes a structurally-valid query and returns the registry's objections as
 * data — a code, the path that offended, a human message, and, where it helps,
 * the list of values that *would* have been accepted. The collector turns them
 * into one `400`; a test can assert on the codes without matching prose.
 *
 * Nothing here executes anything, touches a store, or knows what a dialect is.
 * The compilation itself lives in `@uptimizr/db`'s `query/dsl`.
 *
 * ## The two compilation tiers
 *
 * A query runs on one of two tiers (design sketch §C.2), and which one is a
 * registry question as well:
 *
 * - **delegated** — the metric's *existing* aggregation builder runs, so the
 *   result is what the canned endpoint has always returned. This is every query
 *   at the metric's own grain, and the only tier a spatial or percentile metric
 *   has.
 * - **generic** — a metric that declares `genericGroupBy` (a portable
 *   count/sum over promoted columns) is recomputed at an arbitrary grain by one
 *   shared builder: any subset of the dimensions it declares, plus the `event`
 *   and `device` predicates no canned builder ever took.
 *
 * {@link queryTier} answers which, from the query and the registry alone — no
 * store, no dialect, no SQL.
 *
 * ## What is accepted
 *
 * - `metric` — any registry id with a `builder`. The two builder-less
 *   **resource** entries (`session_meta`, `scene_representation`) are single
 *   store reads, not aggregations, and are rejected.
 * - `dimensions` — omitted, or the metric's {@link nativeDimensions}, on either
 *   tier; on the generic tier additionally any subset of the metric's declared
 *   dimensions that the tier can render ({@link genericDimensions}).
 * - `filters` — the filter ids the metric declares, plus the ids it carries in
 *   its path (a session trajectory's `session`), which are required.
 *   `filters.event` (an ADR 0038 predicate) and `filters.device` are
 *   **generic-tier only**: no canned builder takes either.
 * - `segment` / `compare.segment` — dimensions the metric can hold fixed: an
 *   accepted filter on either tier, any renderable dimension on the generic one.
 * - `order` — a measure column, on the generic tier or on a **ranked** delegated
 *   metric. A series, a hotspot grid and a single-row record each already have
 *   the one order that means anything, and re-sorting them would be noise.
 * - `compare` and `explain` — accepted on both tiers. Neither changes the SQL of
 *   the query itself, so neither is a tier question.
 * - `limit` — at most the metric's `limits.maxRows`.
 */

import type { QueryFilters, QueryV1 } from "@uptimizr/schema";
import {
  DIMENSION_ROW_COLUMNS,
  FILTER_TARGETS,
  GENERIC_DIMENSIONS,
  getMetric,
  isResourceMetric,
  type DimensionId,
  type FilterId,
  type MetricDefinition,
} from "./registry.js";

/**
 * The dimensions a metric's rows are **actually keyed by** — its native grain —
 * as opposed to the dimensions it can merely be *filtered* or *regrouped* by,
 * which is what `MetricDefinition.dimensions` lists.
 *
 * A thin accessor over registry data since #304: the grain is declared on each
 * entry as `grainDimensions` rather than derived from `row.shape` at call time.
 * `top_meshes` declares `["mesh", "session"]` but is keyed by `["mesh"]`, so a
 * `dimensions: ["session"]` query is a *regrouping* (the generic tier) rather
 * than the metric's own result. `src/__tests__/registry.test.ts` keeps the old
 * derivation, as the gate on the declaration.
 */
export function nativeDimensions(metric: MetricDefinition): readonly DimensionId[] {
  return metric.grainDimensions;
}

/**
 * The dimensions this metric can be **grouped by** on the generic tier: the ones
 * it declares, intersected with the ones that tier can render at all. Empty for
 * a metric with no `genericGroupBy` — a spatial or percentile metric is stuck
 * with its own grain, and says so.
 */
export function genericDimensions(metric: MetricDefinition): readonly DimensionId[] {
  if (metric.genericGroupBy == null) return [];
  return metric.dimensions.filter((dimension) => GENERIC_DIMENSIONS.includes(dimension));
}

/**
 * The row column a dimension is projected as for this metric.
 *
 * A metric already keyed by the dimension keeps its own spelling —
 * `top_input_actions` calls the `name` column `action`, `mesh_interaction_kinds`
 * calls it `kind` — so regrouping a metric never renames a column it already
 * returns. Anything else takes the canonical name from
 * {@link DIMENSION_ROW_COLUMNS}; `cameraMode`, which no aggregation projects,
 * becomes `camera_mode`.
 */
export function dimensionColumn(metric: MetricDefinition, dimension: DimensionId): string {
  const candidates = DIMENSION_ROW_COLUMNS[dimension];
  const own = candidates.find((column) => column in metric.row.shape);
  return own ?? candidates[0] ?? "camera_mode";
}

/**
 * Filters a metric cannot be queried without, beyond the ones it carries in its
 * path. The collector declares these required in its querystring schema
 * (`funnelQueryParams.steps`, `meshUvHeatmapQueryParams.mesh`) and the builders
 * take them as non-optional options; the registry records requiredness in prose
 * rather than as data, so the two exceptions are listed here — once, in the
 * vocabulary package, for the DSL and the generated tool catalog to share.
 */
export const REQUIRED_FILTERS: Readonly<Record<string, readonly FilterId[]>> = {
  funnel: ["steps"],
  mesh_uv_heatmap: ["mesh"],
  // An insight is a metric computed *over* another metric, so `baseline` has no
  // meaning until its subject is named (ADR 0051 §4).
  insight_baseline: ["metric"],
};

/**
 * Filter ids that never travel in a DSL `filters` object: the time window is the
 * required `range`, and `format` selects the response envelope rather than
 * narrowing anything, so it is a top-level field.
 */
const NON_FILTER_IDS: readonly FilterId[] = ["since", "until", "format"];

/**
 * The two filters only the generic tier can apply, and what each one does.
 * Declared as data so the "generic-tier only" line in the docs and the message a
 * client actually receives cannot drift.
 */
const GENERIC_ONLY_FILTERS: Readonly<Record<"event" | "device", string>> = {
  event: "scoping a metric to an event predicate (ADR 0038)",
  device: "filtering by the device attributes of a session",
};

/** Units whose column can be ordered by: a measure, not a label or a key. */
const ORDERABLE_UNITS: ReadonlySet<string> = new Set([
  "count",
  "sessions",
  "ms",
  "s",
  "fps",
  "ratio",
  "percent",
  "world-units",
  "radians",
  "bytes",
]);

/**
 * Grains whose result is a **ranked list** — the only delegated shape where the
 * caller choosing the order means anything. A `bucket` metric walks an axis, a
 * `bin`/`voxel` metric is a grid, and a `project` metric is one row; re-sorting
 * any of those says nothing and would silently reinterpret the result.
 */
const RANKED_GRAINS: ReadonlySet<string> = new Set(["mesh", "scene", "session", "row"]);

/** Which compilation tier a validated query runs on. */
export type QueryTier = "delegated" | "generic";

/** Whether the asked-for dimensions are exactly the metric's own grain. */
function isNativeGrain(
  metric: MetricDefinition,
  dimensions: readonly string[] | undefined,
): boolean {
  if (dimensions == null) return true;
  const asked = new Set(dimensions);
  const grain = nativeDimensions(metric);
  return asked.size === grain.length && grain.every((dimension) => asked.has(dimension));
}

/** The dimensions a metric can hold fixed through one of its ordinary filters. */
function segmentableAsFilter(metric: MetricDefinition): ReadonlySet<string> {
  return new Set<string>(queryableFilters(metric));
}

/** Every `segment` key a query carries, its own and its comparison's. */
function segmentKeys(query: QueryV1): readonly string[] {
  const compared =
    query.compare != null && "segment" in query.compare ? Object.keys(query.compare.segment) : [];
  return [...Object.keys(query.segment ?? {}), ...compared];
}

/**
 * Which tier a query runs on.
 *
 * The delegated tier is preferred wherever it can answer, so an unchanged query
 * keeps returning the canned endpoint's exact bytes and the generic builder is
 * reached only by asking for something the metric's own builder cannot do: a
 * different grain, an event or device predicate, or a segment on a dimension
 * that is not one of its filters.
 */
export function queryTier(metric: MetricDefinition, query: QueryV1): QueryTier {
  if (metric.genericGroupBy == null) return "delegated";
  if (!isNativeGrain(metric, query.dimensions)) return "generic";
  if (query.filters?.event != null || query.filters?.device != null) return "generic";
  const filterable = segmentableAsFilter(metric);
  if (segmentKeys(query).some((key) => !filterable.has(key))) return "generic";
  return "delegated";
}

/**
 * The columns a query may `order` by — empty when the metric's result has no
 * caller-choosable order at all (see {@link RANKED_GRAINS}).
 *
 * On the generic tier that is exactly the measures the generic builder projects;
 * on the delegated tier it is the metric's own numeric measure columns, because
 * those are the only ones present in every row it returns.
 */
export function orderableColumns(
  metric: MetricDefinition,
  tier: QueryTier = "delegated",
): readonly string[] {
  if (tier === "generic") {
    return (metric.genericGroupBy?.measures ?? []).map((measure) => measure.column);
  }
  if (!RANKED_GRAINS.has(metric.grain)) return [];
  return Object.entries(metric.columns)
    .filter(
      ([, semantics]) => semantics.measure === true || ORDERABLE_UNITS.has(semantics.unit ?? ""),
    )
    .map(([name]) => name);
}

/** Why a query was rejected. Stable, matchable in a test without parsing prose. */
export type QueryIssueCode =
  /** `metric` names nothing in the registry. */
  | "unknown_metric"
  /** `metric` names a resource read (`session_meta`, `scene_representation`), not an aggregation. */
  | "metric_not_queryable"
  /** A dimension the metric does not declare at all. */
  | "unknown_dimension"
  /** A dimension the metric declares but is not keyed by, and cannot be regrouped by. */
  | "dimension_not_native"
  /** A declared dimension the generic tier cannot render (see `GENERIC_DIMENSIONS`). */
  | "dimension_not_groupable"
  /** A filter the metric does not accept. */
  | "unsupported_filter"
  /** A filter the metric cannot be queried without. */
  | "missing_filter"
  /** `limit` exceeds the metric's registry cap. */
  | "limit_too_large"
  /** `order.by` is not a column this metric's result can be ordered by. */
  | "unsupported_order"
  /** A `segment` / `compare.segment` dimension this metric cannot hold fixed. */
  | "unsupported_segment"
  /** A grammar feature this metric cannot support (`filters.event` on a delegated metric). */
  | "unsupported_feature";

/** One registry objection to a query. */
export interface QueryIssue {
  code: QueryIssueCode;
  /** Dotted path into the query, e.g. `filters.cameraMode` or `dimensions[1]`. */
  path: string;
  /** Human-readable, and specific enough to fix the query from. */
  message: string;
  /** What would have been accepted here, when that is a closed list. */
  accepted?: readonly string[];
}

/** The outcome of validating a query against the registry. */
export interface QueryValidation {
  /** Empty when the query is executable. */
  issues: readonly QueryIssue[];
  /** The resolved metric, when `metric` named one with a builder. */
  metric?: MetricDefinition;
  /** The tier the query runs on, when `metric` resolved. */
  tier?: QueryTier;
}

/** `` `a`, `b` `` — for a message listing what is accepted. */
function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map((value) => `\`${value}\``).join(", ");
}

/**
 * The filter ids a metric accepts in a DSL query: the ones it declares, plus the
 * ones it carries in its path (a session trajectory's `session` is a filter here
 * even though the canned route spells it as a path segment), minus the three
 * that are not filters in the DSL.
 */
export function queryableFilters(metric: MetricDefinition): readonly FilterId[] {
  const ids = new Set<FilterId>(metric.filters);
  for (const id of metric.endpoint?.pathParams ?? []) ids.add(id);
  for (const id of NON_FILTER_IDS) ids.delete(id);
  return [...ids];
}

/**
 * Filters a DSL query for this metric must carry: everything the canned endpoint
 * puts in its path (always required — a trajectory without a session is not a
 * query) plus the metric's {@link REQUIRED_FILTERS}.
 */
export function requiredFilters(metric: MetricDefinition): readonly FilterId[] {
  const ids = new Set<FilterId>(metric.endpoint?.pathParams ?? []);
  for (const id of REQUIRED_FILTERS[metric.id] ?? []) ids.add(id);
  return [...ids];
}

/**
 * The dimensions a metric can hold fixed as a `segment`: an accepted filter on
 * either tier, or any dimension the generic tier can render.
 */
export function segmentableDimensions(metric: MetricDefinition): readonly string[] {
  const declared = new Set<string>(metric.dimensions);
  const holdable = new Set<string>([...segmentableAsFilter(metric), ...genericDimensions(metric)]);
  return [...holdable].filter((id) => declared.has(id));
}

/** Validate one `segment` object — the query's own, or its `compare.segment`. */
function checkSegment(
  metric: MetricDefinition,
  segment: Readonly<Record<string, string>> | undefined,
  path: string,
  issues: QueryIssue[],
): void {
  if (segment == null) return;
  const declared = new Set<string>(metric.dimensions);
  const holdable = segmentableDimensions(metric);
  const holdableSet = new Set(holdable);
  for (const key of Object.keys(segment)) {
    if (!declared.has(key)) {
      issues.push({
        code: "unknown_dimension",
        path: `${path}.${key}`,
        message: `"${metric.id}" has no dimension "${key}". It declares ${list([...declared])}.`,
        accepted: [...declared],
      });
      continue;
    }
    if (holdableSet.has(key)) continue;
    issues.push({
      code: "unsupported_segment",
      path: `${path}.${key}`,
      message:
        `"${metric.id}" cannot be held fixed at a "${key}": its builder takes no such filter and ` +
        `it has no generic group-by tier. It can be segmented by ${list(holdable)}.`,
      accepted: holdable,
    });
  }
}

/**
 * Check a structurally-valid query against the registry.
 *
 * Every objection is collected rather than thrown on the first one: an agent
 * that mis-specified two things should learn both in one round trip. An empty
 * `issues` array means the compiler can run the query as written, on the
 * returned `tier`.
 */
export function validateQuery(query: QueryV1): QueryValidation {
  const issues: QueryIssue[] = [];
  const metric = getMetric(query.metric);

  if (!metric) {
    issues.push({
      code: "unknown_metric",
      path: "metric",
      message:
        `unknown metric "${query.metric}". The metric vocabulary is the registry — read it from ` +
        "`GET /api/v1/openapi.json` or the MCP resource `uptimizr://capabilities`.",
    });
    return { issues };
  }
  if (metric.builder === undefined) {
    // Two kinds of entry have no `build*` for the DSL to delegate to: a stored
    // record (`session_meta`, `scene_representation`) and a **derived** insight
    // primitive, which is computed in TypeScript *over* another metric's bucket
    // series (ADR 0051 §4). Neither can be grouped, filtered or summarised by a
    // query, and both are served on an endpoint of their own — so the honest
    // answer names it rather than failing later in the compiler.
    issues.push({
      code: "metric_not_queryable",
      path: "metric",
      message: isResourceMetric(metric)
        ? `"${metric.id}" is a stored record rather than an aggregation, so it has nothing to ` +
          `group, filter or summarise. Read it from its own endpoint (${metric.endpoint?.path ?? "—"}).`
        : `"${metric.id}" is a derived insight computed over another metric rather than an ` +
          `aggregation of its own, so the query DSL cannot compile it. Read it from its own ` +
          `endpoint (${metric.endpoint?.path ?? "—"}), naming the metric to analyse there.`,
    });
    return { issues };
  }

  const tier = queryTier(metric, query);

  // --- dimensions ---------------------------------------------------------
  const native = nativeDimensions(metric);
  // A repeated dimension groups by the same column twice: harmless in SQL, but
  // it means the caller asked for something other than what they would get, and
  // it makes `dimensions` compare equal to a grain it is not.
  const seen = new Set<string>();
  (query.dimensions ?? []).forEach((dimension, index) => {
    if (seen.has(dimension)) {
      issues.push({
        code: "unknown_dimension",
        path: `dimensions[${index}]`,
        message: `\`dimensions\` names "${dimension}" twice; each dimension groups once.`,
      });
    }
    seen.add(dimension);
  });
  if (query.dimensions != null && !isNativeGrain(metric, query.dimensions)) {
    const declared = new Set<string>(metric.dimensions);
    const groupable = new Set<string>(genericDimensions(metric));
    query.dimensions.forEach((dimension, index) => {
      if (!declared.has(dimension)) {
        issues.push({
          code: "unknown_dimension",
          path: `dimensions[${index}]`,
          message: `"${metric.id}" has no dimension "${dimension}". It declares ${list([...declared])}.`,
          accepted: [...declared],
        });
        return;
      }
      if (metric.genericGroupBy == null) {
        issues.push({
          code: "dimension_not_native",
          path: `dimensions[${index}]`,
          message:
            `"${metric.id}" can be filtered by "${dimension}" but is not grouped by it: its rows ` +
            `are keyed by ${list([...native])}, and its measure cannot be recomputed at another ` +
            "grain (it is a spatial binning or a percentile). Pass it as a filter instead.",
          accepted: [...native],
        });
        return;
      }
      if (!groupable.has(dimension)) {
        issues.push({
          code: "dimension_not_groupable",
          path: `dimensions[${index}]`,
          message:
            `"${metric.id}" declares "${dimension}" but the generic group-by tier cannot render ` +
            `it. Group by ${list([...groupable])}, or pass it as a filter.`,
          accepted: [...groupable],
        });
      }
    });
  }

  // --- filters ------------------------------------------------------------
  const accepted = queryableFilters(metric);
  const acceptedSet = new Set<string>(accepted);
  for (const key of Object.keys(query.filters ?? {})) {
    if (key === "event" || key === "device") {
      if (metric.genericGroupBy != null) {
        // `gpuTier` is in the published grammar but nothing captures it: the
        // `session_start` device payload carries `engine`, `renderer`,
        // `isMobile` and the two UA-derived families, and no connector reports a
        // tier. Accepting it would match nothing and read as "no such device",
        // which is the one answer worse than a refusal.
        if (key === "device" && query.filters?.device?.gpuTier != null) {
          issues.push({
            code: "unsupported_filter",
            path: "filters.device.gpuTier",
            message:
              "no connector reports a GPU tier, so `filters.device.gpuTier` would match nothing " +
              "rather than narrow anything. The device attributes that exist are `os` and " +
              "`browser` (both derived from the User-Agent at ingestion); group by " +
              "`device.renderer` for the GPU itself.",
            accepted: ["os", "browser"],
          });
        }
        continue;
      }
      issues.push({
        code: "unsupported_feature",
        path: `filters.${key}`,
        message:
          `${GENERIC_ONLY_FILTERS[key]} needs the generic group-by tier, and "${metric.id}" has ` +
          "none: its measure is a spatial binning or a percentile, which cannot be recomputed " +
          "over an arbitrary subset of events. Scope it with the filters it declares instead: " +
          `${list([...accepted])}.`,
        accepted: [...accepted],
      });
      continue;
    }
    if (acceptedSet.has(key)) continue;
    issues.push({
      code: "unsupported_filter",
      path: `filters.${key}`,
      message: `"${metric.id}" does not accept the filter "${key}". It accepts ${list([...accepted])}.`,
      accepted: [...accepted],
    });
  }
  for (const id of requiredFilters(metric)) {
    if (query.filters?.[id as keyof QueryFilters] != null) continue;
    issues.push({
      code: "missing_filter",
      path: `filters.${id}`,
      message: `"${metric.id}" cannot be queried without the filter "${id}": ${FILTER_TARGETS[id].description}`,
    });
  }

  // --- segment / compare --------------------------------------------------
  checkSegment(metric, query.segment, "segment", issues);
  if (query.compare != null && "segment" in query.compare) {
    checkSegment(metric, query.compare.segment, "compare.segment", issues);
  }

  // --- order --------------------------------------------------------------
  if (query.order != null) {
    const orderable = orderableColumns(metric, tier);
    if (!orderable.includes(query.order.by)) {
      issues.push({
        code: "unsupported_order",
        path: "order.by",
        message:
          orderable.length === 0
            ? `"${metric.id}" returns its rows in the one order that means anything (a time axis, ` +
              "a grid of cells, or a single record), so it cannot be reordered. Omit `order`."
            : `"${metric.id}" cannot be ordered by "${query.order.by}". Order by one of its ` +
              `measure columns: ${list(orderable)}.`,
        accepted: orderable,
      });
    }
  }

  // --- limit --------------------------------------------------------------
  // `limit` is a filter like any other, spelled at the top level because every
  // bounded result has one. A metric whose builder takes no row cap (a one-row
  // summary, a fixed-width histogram) must say so rather than accept the
  // parameter and ignore it. The generic tier always bounds its own output, so
  // it takes a `limit` whatever the canned endpoint does.
  if (query.limit != null && tier === "delegated" && !acceptedSet.has("limit")) {
    issues.push({
      code: "unsupported_filter",
      path: "limit",
      message:
        `"${metric.id}" returns a fixed result (one row per ${metric.grain}) and takes no row cap. ` +
        "Omit `limit`.",
    });
  } else if (query.limit != null && query.limit > metric.limits.maxRows) {
    issues.push({
      code: "limit_too_large",
      path: "limit",
      message: `"${metric.id}" returns at most ${metric.limits.maxRows} rows; ${query.limit} was asked for.`,
    });
  }

  return { issues, metric, tier };
}
