/**
 * **The generic group-by compiler** (ADR 0051 §3, design sketch §C.2, tier 2).
 *
 * The delegated tier (`compile.ts`) can run any metric, but only at the grain
 * its builder renders: `top_meshes` is one row per mesh and nothing else. That
 * is right for a spatial binning or a percentile — those measures *are* their
 * grain — but wrong for a count. "How many mesh interactions per input source"
 * and "…per scene" are the same question about the same events, and the only
 * reason they needed two endpoints is that somebody wrote two `GROUP BY`s.
 *
 * So a metric that declares `genericGroupBy` in the registry (a portable
 * `count` / `count(DISTINCT session_id)` / `sum` / `avg` / `max` over promoted
 * columns) gets one shared, dialect-authored builder that renders
 *
 * ```sql
 * SELECT <dimensions>, <measures>
 *   FROM events [LEFT JOIN session_attrs …]
 *  WHERE project_id = ? AND <event types> AND <scope> AND <range> AND <filters>
 *  GROUP BY <dimensions>
 *  ORDER BY <measure> DESC, <dimensions>
 *  LIMIT ?
 * ```
 *
 * for **any** subset of the dimensions that metric declares.
 *
 * ## Why this is still only one SQL path
 *
 * Everything variable in the SQL above comes from **registry data**, never from
 * the request: the event types and the scope predicate are the metric's
 * `genericGroupBy`, the measures are its declared columns, and each dimension's
 * expression is chosen from a closed table keyed by `DimensionId`. Every value a
 * caller supplies — a scene id, a mesh name, an event predicate — reaches the
 * SQL as a bound parameter through the same {@link ParamBag} the canned
 * aggregations use. There is no string interpolation of caller input anywhere in
 * this file, which is what makes a grammar with a `GROUP BY` in it still a
 * closed grammar.
 *
 * ## Portability
 *
 * The promoted dimensions (`scene_id`, `session_id`, `mesh`, `name`, `source`,
 * `event_type`) are plain columns on every engine. The session attributes
 * (`cameraMode`, `device.*`) live in the `session_start` payload, so they are
 * read through `Dialect.jsonText` in one CTE and `LEFT JOIN`ed on `session_id`
 * — the same shape `buildPerfByDevice` has always used. `GROUP BY` repeats the
 * expressions rather than naming the output aliases, because T-SQL rejects the
 * latter (the mssql dialect rewrites it, but not relying on the rewrite is
 * cheaper than relying on it).
 *
 * The one session attribute deliberately left out is `device.isMobile`: it is a
 * boolean, and a group-by on it would key rows by `"true"` on one engine and `1`
 * on another. `GENERIC_DIMENSIONS` in the registry says so, and `validateQuery`
 * refuses it by name.
 */

import {
  dimensionColumn,
  type DimensionId,
  type GenericMeasure,
  type MetricDefinition,
  type MetricId,
} from "@uptimizr/metrics";
import { ParamBag, cameraModeClause, rangeClause, type Dialect } from "../dialect.js";
import type { QuerySpec } from "../types.js";

/**
 * A funnel-step predicate (ADR 0038) as the generic tier takes it. Structurally
 * the schema's `FunnelStep`, restated as a local shape so this module keeps no
 * dependency on `@uptimizr/schema`.
 */
export interface GenericEventPredicate {
  type: string;
  name?: string;
  mesh?: string;
}

/** Device attributes a generic query can be scoped to. */
export interface GenericDeviceFilter {
  os?: string;
  browser?: string;
}

/**
 * The option bag the generic builder takes. Assembled by
 * {@link import("./compile.js").toBuilderOptions} from a validated query; every
 * field is already registry-checked by the time it gets here.
 */
export interface GenericQueryOptions {
  /** Inclusive lower bound (epoch ms). */
  since?: number;
  /** Exclusive upper bound (epoch ms). */
  until?: number;
  /** The grain to group by. Empty means "one row for the whole range". */
  dimensions?: readonly DimensionId[];
  scene?: string;
  session?: string;
  source?: string;
  mesh?: string;
  /** The stored `scene.cameraType`, already mapped from the DSL's `cameraMode`. */
  cameraType?: string;
  /** Restrict to sessions whose `session_start` declares these attributes. */
  device?: GenericDeviceFilter;
  /** Restrict to sessions in which at least one matching event occurred. */
  event?: GenericEventPredicate;
  /** Dimensions held fixed at a value, keyed by `DimensionId`. */
  segment?: Readonly<Record<string, string>>;
  /** Result order; defaults to the first measure, descending. */
  order?: { by: string; dir: "asc" | "desc" };
  /** Row cap. Always applied — a generic group-by is unbounded without one. */
  limit?: number;
}

/** The default row cap when a caller names none. */
const DEFAULT_GENERIC_LIMIT = 200;

/** Session attributes read out of the `session_start` payload, by dimension. */
const SESSION_ATTRIBUTE_PATHS: Readonly<Record<string, readonly string[]>> = {
  cameraMode: ["scene", "cameraType"],
  "device.engine": ["device", "engine"],
  "device.renderer": ["device", "renderer"],
  "device.browser": ["device", "browser"],
  "device.os": ["device", "os"],
};

/** Promoted `events` columns, by dimension. The rest come from the CTE. */
const PROMOTED_COLUMNS: Readonly<Record<string, string>> = {
  scene: "scene_id",
  session: "session_id",
  mesh: "mesh",
  name: "name",
  source: "source",
  event_type: "event_type",
};

/** The CTE the session-attribute dimensions are read from. */
const SESSION_CTE = "session_attrs";

/** A dimension, resolved to the SQL that groups by it. */
interface ResolvedDimension {
  id: DimensionId;
  /** Output column name in the result row. */
  column: string;
  /** The expression `SELECT` projects and `GROUP BY` repeats. */
  expression: string;
}

/** Whether a dimension is read from the joined `session_start` attributes. */
function isSessionAttribute(dimension: string): boolean {
  return dimension in SESSION_ATTRIBUTE_PATHS;
}

/** Sanitised alias for a session attribute inside the CTE (`device.os` → `sa_os`). */
function attributeAlias(dimension: string): string {
  return `sa_${dimension
    .replace(/^device\./, "")
    .replace(/[^A-Za-z0-9]/g, "_")
    .toLowerCase()}`;
}

/** Resolve every asked-for dimension to its output column and SQL expression. */
function resolveDimensions(
  metric: MetricDefinition,
  dimensions: readonly DimensionId[],
): readonly ResolvedDimension[] {
  return dimensions.map((id) => ({
    id,
    column: dimensionColumn(metric, id),
    expression: isSessionAttribute(id)
      ? `${SESSION_CTE}.${attributeAlias(id)}`
      : `events.${PROMOTED_COLUMNS[id] ?? id}`,
  }));
}

/** Render one measure column. */
function renderMeasure(measure: GenericMeasure): string {
  switch (measure.kind) {
    case "count":
      return `count(*) AS ${measure.column}`;
    case "sessions":
      return `count(DISTINCT events.session_id) AS ${measure.column}`;
    case "sum":
      return `sum(events.${measure.of}) AS ${measure.column}`;
    case "avg":
      return `avg(events.${measure.of}) AS ${measure.column}`;
    case "max":
      return `max(events.${measure.of}) AS ${measure.column}`;
  }
}

/**
 * `event_type IN (…)`, every type a bound parameter. Empty for a metric whose
 * subject is the whole stream (`event_counts`).
 */
function eventTypeClause(bag: ParamBag, types: readonly string[]): string {
  if (types.length === 0) return "";
  const bound = types.map((type, index) => bag.add(`gType${index}`, "string", type));
  return ` AND events.event_type IN (${bound.join(", ")})`;
}

/**
 * The metric's own scope predicate, so a regrouped result counts the same
 * population its builder counts. Closed: each value is one non-empty test on a
 * promoted column, named by the registry, never by the caller.
 */
function scopeClause(scope: readonly string[] | undefined): string {
  const parts = (scope ?? []).map((rule) =>
    rule === "hasMesh" ? "events.mesh != ''" : "events.name != ''",
  );
  return parts.length === 0 ? "" : ` AND ${parts.join(" AND ")}`;
}

/** An equality predicate on a promoted column, or `""` when the value is absent. */
function equality(bag: ParamBag, column: string, param: string, value: string | undefined): string {
  if (value == null || value.length === 0) return "";
  return ` AND events.${column} = ${bag.add(param, "string", value)}`;
}

/**
 * `session_id IN (SELECT … FROM session_start WHERE <attribute> = ?)` — the
 * device filter, rendered exactly like the camera-mode filter it sits next to so
 * it composes with every other clause and needs no join.
 */
function deviceClause(
  bag: ParamBag,
  d: Dialect,
  projectId: string,
  device: GenericDeviceFilter | undefined,
): string {
  const tests: string[] = [];
  if (device?.os != null && device.os.length > 0) {
    tests.push(
      `${d.jsonText("payload", "device", "os")} = ${bag.add("devOs", "string", device.os)}`,
    );
  }
  if (device?.browser != null && device.browser.length > 0) {
    tests.push(
      `${d.jsonText("payload", "device", "browser")} = ` +
        `${bag.add("devBrowser", "string", device.browser)}`,
    );
  }
  if (tests.length === 0) return "";
  const pid = bag.add("devProjectId", "string", projectId);
  return ` AND events.session_id IN (
        SELECT session_id FROM events
        WHERE project_id = ${pid} AND event_type = 'session_start' AND ${tests.join(" AND ")}
      )`;
}

/**
 * `session_id IN (SELECT … WHERE <the step predicate>)` — the ADR 0038 event
 * filter.
 *
 * It is a **cohort** predicate, not a row predicate: it keeps the sessions in
 * which the event happened at least once, and the metric then counts its own
 * events within them. That is the useful question ("what did the people who
 * reached checkout look at") and the one the funnel grammar already answers;
 * narrowing the counted rows themselves is what `filters.event_type`-style
 * dimensions and `eventTypes` already do.
 */
function eventPredicateClause(
  bag: ParamBag,
  projectId: string,
  event: GenericEventPredicate | undefined,
): string {
  if (event == null) return "";
  const parts = [`event_type = ${bag.add("evType", "string", event.type)}`];
  if (event.name != null && event.name.length > 0) {
    parts.push(`name = ${bag.add("evName", "string", event.name)}`);
  }
  if (event.mesh != null && event.mesh.length > 0) {
    parts.push(`mesh = ${bag.add("evMesh", "string", event.mesh)}`);
  }
  const pid = bag.add("evProjectId", "string", projectId);
  return ` AND events.session_id IN (
        SELECT session_id FROM events
        WHERE project_id = ${pid} AND ${parts.join(" AND ")}
      )`;
}

/**
 * Equality predicates for the dimensions a `segment` holds fixed. Only the
 * dimensions the delegated filters cannot express reach here — the rest arrive
 * as ordinary filter options.
 */
function segmentClauses(
  bag: ParamBag,
  d: Dialect,
  projectId: string,
  segment: Readonly<Record<string, string>> | undefined,
): string {
  if (segment == null) return "";
  const parts: string[] = [];
  let index = 0;
  for (const [dimension, value] of Object.entries(segment)) {
    if (value == null || value.length === 0) continue;
    const param = `seg${index++}`;
    const path = SESSION_ATTRIBUTE_PATHS[dimension];
    if (path != null) {
      const pid = bag.add(`${param}ProjectId`, "string", projectId);
      parts.push(
        `events.session_id IN (
        SELECT session_id FROM events
        WHERE project_id = ${pid} AND event_type = 'session_start'
          AND ${d.jsonText("payload", ...path)} = ${bag.add(param, "string", value)}
      )`,
      );
      continue;
    }
    const column = PROMOTED_COLUMNS[dimension];
    if (column == null) continue;
    parts.push(`events.${column} = ${bag.add(param, "string", value)}`);
  }
  return parts.length === 0 ? "" : ` AND ${parts.join(" AND ")}`;
}

/**
 * The `session_start` attribute CTE and its join, rendered only when a session
 * attribute is actually one of the grouping dimensions. A device or camera-mode
 * *filter* never needs it — those are sub-selects.
 */
function sessionAttributes(
  bag: ParamBag,
  d: Dialect,
  projectId: string,
  dimensions: readonly ResolvedDimension[],
): { cte: string; join: string } {
  const attributes = dimensions.filter((dimension) => isSessionAttribute(dimension.id));
  if (attributes.length === 0) return { cte: "", join: "" };
  const pid = bag.add("saProjectId", "string", projectId);
  const projections = attributes.map(
    (dimension) =>
      `${d.jsonText("payload", ...(SESSION_ATTRIBUTE_PATHS[dimension.id] ?? []))} AS ` +
      `${attributeAlias(dimension.id)}`,
  );
  return {
    cte: `WITH ${SESSION_CTE} AS (
        SELECT session_id AS sa_session, ${projections.join(", ")}
        FROM events
        WHERE project_id = ${pid} AND event_type = 'session_start'
      )
      `,
    join: `
      LEFT JOIN ${SESSION_CTE} ON ${SESSION_CTE}.sa_session = events.session_id`,
  };
}

/**
 * Compile a generic group-by query for one metric.
 *
 * `metric` must declare `genericGroupBy` — the caller (`compileMetric`) has
 * already checked that, and `validateQuery` before it, so the throw below guards
 * a programming error rather than a client one.
 */
export function buildGenericGroupBy(
  metric: MetricDefinition,
  projectId: string,
  opts: GenericQueryOptions,
  d: Dialect,
): QuerySpec {
  const spec = metric.genericGroupBy;
  if (spec == null) {
    throw new Error(
      `metric '${metric.id}' declares no genericGroupBy and cannot be grouped by an arbitrary grain`,
    );
  }

  const bag = new ParamBag(d);
  const dimensions = resolveDimensions(metric, opts.dimensions ?? metric.grainDimensions);
  // The attribute CTE binds its own project id, and must be rendered before the
  // outer clauses so the parameters read in source order.
  const attributes = sessionAttributes(bag, d, projectId, dimensions);

  const pid = bag.add("projectId", "string", projectId);
  const where = [
    eventTypeClause(bag, spec.eventTypes),
    scopeClause(spec.scope),
    rangeClause(bag, opts),
    equality(bag, "scene_id", "scene", opts.scene),
    equality(bag, "session_id", "session", opts.session),
    equality(bag, "source", "source", opts.source),
    equality(bag, "mesh", "mesh", opts.mesh),
    cameraModeClause(bag, d, projectId, opts),
    deviceClause(bag, d, projectId, opts.device),
    eventPredicateClause(bag, projectId, opts.event),
    segmentClauses(bag, d, projectId, opts.segment),
  ].join("");

  const measures = spec.measures.map(renderMeasure);
  const selected = [
    ...dimensions.map((dimension) => `${dimension.expression} AS ${dimension.column}`),
    ...measures,
  ];

  // Order by the asked-for measure, then by every dimension, so the row set a
  // `LIMIT` keeps is a function of the data rather than of the engine's
  // scan order — the same reason the summariser breaks ties on the label.
  const primary = opts.order?.by ?? spec.measures[0]?.column ?? "1";
  const direction = opts.order?.dir === "asc" ? "ASC" : "DESC";
  const order = [
    `${primary} ${direction}`,
    ...dimensions.map((dimension) => `${dimension.expression} ASC`),
  ].join(", ");

  const limit = bag.add("limit", "u32", opts.limit ?? DEFAULT_GENERIC_LIMIT);
  const groupBy =
    dimensions.length === 0
      ? ""
      : `
      GROUP BY ${dimensions.map((dimension) => dimension.expression).join(", ")}`;

  return {
    query: `
      ${attributes.cte}SELECT ${selected.join(", ")}
      FROM events${attributes.join}
      WHERE events.project_id = ${pid}${where}${groupBy}
      ORDER BY ${order}
      LIMIT ${limit}
    `,
    metric: metric.id as MetricId,
    query_params: bag.values,
  };
}

/**
 * The columns a generic group-by result carries, in order: the grouping
 * dimensions, then the metric's measures. Used by the explain plan and by the
 * tests that assert a generic row is self-describing.
 */
export function genericResultColumns(
  metric: MetricDefinition,
  dimensions: readonly DimensionId[],
): readonly string[] {
  return [
    ...dimensions.map((dimension) => dimensionColumn(metric, dimension)),
    ...(metric.genericGroupBy?.measures ?? []).map((measure) => measure.column),
  ];
}
