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
 * ## What v1 accepts
 *
 * v1 is the **delegated** tier (design sketch §C.2): a query runs the metric's
 * existing aggregation builder, so every metric is reachable at exactly the
 * power its canned endpoint already has, and no more. Concretely:
 *
 * - `metric` — any registry id with a `builder`. The two builder-less
 *   **resource** entries (`session_meta`, `scene_representation`) are single
 *   store reads, not aggregations, and are rejected.
 * - `dimensions` — omitted, or exactly the metric's {@link nativeDimensions}
 *   (in any order). A builder renders one fixed grain; asking for a different
 *   group-by is a `400` that names what the metric does support.
 * - `filters` — the filter ids the metric declares, plus the ids it carries in
 *   its path (a session trajectory's `session`), which are required.
 * - `limit` — at most the metric's `limits.maxRows`.
 *
 * `compare`, `segment`, `order`, `explain`, `filters.event` and `filters.device`
 * are part of the published grammar and parse cleanly, but are rejected here
 * with {@link QueryIssueCode} `unsupported_feature` until the generic group-by /
 * compare / explain tier lands (#304).
 */

import type { QueryV1 } from "@uptimizr/schema";
import {
  FILTER_TARGETS,
  getMetric,
  isResourceMetric,
  type DimensionId,
  type FilterId,
  type MetricDefinition,
} from "./registry.js";

/**
 * The column a {@link DimensionId} appears as in a metric's `row`, when the
 * metric is keyed by it. Several dimensions are *filterable* on a metric without
 * being part of its grain (`top_meshes` can be scoped to a `session` but returns
 * one row per mesh), which is exactly the difference {@link nativeDimensions}
 * exists to express — so this maps a dimension to the row column that would
 * carry it, and membership in the row decides the rest.
 *
 * Alternatives are listed where the projection name has varied (`scene_id` in a
 * scene rollup, `from_scene` in a transition). `cameraMode` has no entry: no
 * aggregation projects the camera type as a column — it is a filter only.
 */
const DIMENSION_ROW_COLUMNS: Readonly<Record<DimensionId, readonly string[]>> = {
  scene: ["scene_id", "scene"],
  session: ["session_id"],
  mesh: ["mesh"],
  name: ["name", "kind", "action", "phase"],
  source: ["source"],
  event_type: ["event_type"],
  cameraMode: [],
  "device.engine": ["engine"],
  "device.renderer": ["renderer"],
  "device.isMobile": ["is_mobile"],
  "device.browser": ["browser"],
  "device.os": ["os"],
};

/**
 * The dimensions a metric's rows are **actually keyed by** — its native grain —
 * as opposed to the dimensions it can merely be *filtered* by, which is what
 * `MetricDefinition.dimensions` lists.
 *
 * Derived rather than declared, from the one place that cannot be wrong: the
 * metric's own `row` schema. `top_meshes` declares `["mesh", "session"]` but
 * returns `{ mesh, count }`, so its native grain is `["mesh"]` — ask it to break
 * down by `session` and the honest answer is "that metric cannot".
 *
 * Returned in the metric's declaration order, so the message a rejected query
 * gets reads the same way the registry does.
 */
export function nativeDimensions(metric: MetricDefinition): readonly DimensionId[] {
  const columns = new Set(Object.keys(metric.row.shape));
  return metric.dimensions.filter((dimension) =>
    DIMENSION_ROW_COLUMNS[dimension].some((column) => columns.has(column)),
  );
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
};

/**
 * Filter ids that never travel in a DSL `filters` object: the time window is the
 * required `range`, and `format` selects the response envelope rather than
 * narrowing anything, so it is a top-level field.
 */
const NON_FILTER_IDS: readonly FilterId[] = ["since", "until", "format"];

/**
 * Grammar keys that parse but have no delegated implementation, and the issue
 * text that says so. Declared as data so the "v1 accepts / v1 defers" line in
 * the docs and the message a client actually receives cannot drift.
 */
const DEFERRED: Readonly<Record<string, string>> = {
  compare: "comparing two ranges or two segments",
  segment: "holding a dimension fixed as a named segment",
  order: "choosing the result order (each metric's builder has its own)",
  explain: "returning the compiled plan instead of the rows",
  "filters.event": "scoping a metric to an event predicate (ADR 0038)",
  "filters.device": "filtering by device attributes",
};

/** Why a query was rejected. Stable, matchable in a test without parsing prose. */
export type QueryIssueCode =
  /** `metric` names nothing in the registry. */
  | "unknown_metric"
  /** `metric` names a resource read (`session_meta`, `scene_representation`), not an aggregation. */
  | "metric_not_queryable"
  /** A dimension the metric does not declare at all. */
  | "unknown_dimension"
  /** A dimension the metric declares but is not keyed by — it cannot group by it. */
  | "dimension_not_native"
  /** A filter the metric does not accept. */
  | "unsupported_filter"
  /** A filter the metric cannot be queried without. */
  | "missing_filter"
  /** `limit` exceeds the metric's registry cap. */
  | "limit_too_large"
  /** A grammar feature v1 parses but does not execute (#304). */
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
 * Check a structurally-valid query against the registry.
 *
 * Every objection is collected rather than thrown on the first one: an agent
 * that mis-specified two things should learn both in one round trip. An empty
 * `issues` array means the delegated compiler can run the query as written.
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
  if (isResourceMetric(metric)) {
    issues.push({
      code: "metric_not_queryable",
      path: "metric",
      message:
        `"${metric.id}" is a stored record rather than an aggregation, so it has nothing to ` +
        `group, filter or summarise. Read it from its own endpoint (${metric.endpoint?.path ?? "—"}).`,
    });
    return { issues };
  }

  // --- deferred grammar (#304) -------------------------------------------
  for (const [key, what] of Object.entries(DEFERRED)) {
    const present =
      key === "explain"
        ? query.explain === true
        : key.startsWith("filters.")
          ? query.filters?.[key.slice("filters.".length) as "event" | "device"] != null
          : query[key as "compare" | "segment" | "order"] != null;
    if (!present) continue;
    issues.push({
      code: "unsupported_feature",
      path: key,
      message: `${what} is not supported yet — v1 compiles a query onto the metric's existing aggregation (see #304).`,
    });
  }

  // --- dimensions ---------------------------------------------------------
  const native = nativeDimensions(metric);
  if (query.dimensions != null) {
    const declared = new Set<string>(metric.dimensions);
    const nativeSet = new Set<string>(native);
    query.dimensions.forEach((dimension, index) => {
      if (!declared.has(dimension)) {
        issues.push({
          code: "unknown_dimension",
          path: `dimensions[${index}]`,
          message: `"${metric.id}" has no dimension "${dimension}". It declares ${list([...declared])}.`,
          accepted: [...declared],
        });
      } else if (!nativeSet.has(dimension)) {
        issues.push({
          code: "dimension_not_native",
          path: `dimensions[${index}]`,
          message:
            `"${metric.id}" can be filtered by "${dimension}" but is not grouped by it: its rows ` +
            `are keyed by ${list([...native])}. Pass it as a filter instead.`,
          accepted: [...native],
        });
      }
    });
    // The delegated tier renders one fixed grain, so a partial grain is a
    // different query than the one that would run — say so rather than quietly
    // returning more columns than were asked for.
    const asked = new Set(query.dimensions);
    const isNativeGrain = asked.size === native.length && native.every((d) => asked.has(d));
    if (issues.every((issue) => !issue.path.startsWith("dimensions")) && !isNativeGrain) {
      issues.push({
        code: "dimension_not_native",
        path: "dimensions",
        message:
          `"${metric.id}" is computed at one fixed grain: ${list([...native])}. Pass exactly those ` +
          "dimensions, or omit `dimensions` entirely.",
        accepted: [...native],
      });
    }
  }

  // --- filters ------------------------------------------------------------
  const accepted = queryableFilters(metric);
  const acceptedSet = new Set<string>(accepted);
  for (const key of Object.keys(query.filters ?? {})) {
    // The deferred grammar keys report their own, more useful issue above.
    if (key in DEFERRED || `filters.${key}` in DEFERRED) continue;
    if (acceptedSet.has(key)) continue;
    issues.push({
      code: "unsupported_filter",
      path: `filters.${key}`,
      message: `"${metric.id}" does not accept the filter "${key}". It accepts ${list([...accepted])}.`,
      accepted: [...accepted],
    });
  }
  for (const id of requiredFilters(metric)) {
    if (query.filters?.[id as keyof typeof query.filters] != null) continue;
    issues.push({
      code: "missing_filter",
      path: `filters.${id}`,
      message: `"${metric.id}" cannot be queried without the filter "${id}": ${FILTER_TARGETS[id].description}`,
    });
  }

  // --- limit --------------------------------------------------------------
  // `limit` is a filter like any other, spelled at the top level because every
  // bounded result has one. A metric whose builder takes no row cap (a one-row
  // summary, a fixed-width histogram) must say so rather than accept the
  // parameter and ignore it.
  if (query.limit != null && !acceptedSet.has("limit")) {
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

  return { issues, metric };
}
