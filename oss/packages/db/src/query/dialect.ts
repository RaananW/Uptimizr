/**
 * Dialect-agnostic query layer (ADR 0020).
 *
 * Each analytics aggregation is authored *once* in `aggregations.ts` against the
 * {@link Dialect} interface, and rendered to a {@link QuerySpec} per SQL engine.
 * Everything that genuinely differs between engines — bound-parameter syntax,
 * `quantile`, vector norm, time bucketing, ASOF joins, and the rollup `-Merge`
 * combinators — is funnelled through this interface so the bulk of each query
 * stays shared. The OSS default engine is DuckDB; a single-tenant ClickHouse
 * dialect serves the optional scale tier (and may be re-homed to OSS later).
 *
 * Invariant: this layer carries **no multi-tenant concepts** (no `org_id`, no
 * tenant isolation). Those live only in the proprietary scale layer, which keeps
 * the single-tenant dialects relocatable across the open-core boundary.
 */

import type {
  QuerySpec,
  CameraModeOptions,
  RangeOptions,
  SceneOptions,
  SourceOptions,
  SessionOptions,
  RegionOptions,
} from "./types.js";

export type { QuerySpec };

/** Logical bound-parameter type, mapped to an engine-specific type by the dialect. */
export type ParamType = "string" | "u32" | "f64" | "timestamp" | "date";

/**
 * Renders the engine-specific fragments of a query. Implementations must be pure
 * string builders — no I/O, no client coupling — so they stay unit-testable
 * without a live database.
 */
export interface Dialect {
  /** Stable identifier for the engine (e.g. `"clickhouse"`, `"duckdb"`). */
  readonly name: string;
  /** Render a bound-parameter placeholder for the given logical type. */
  placeholder(name: string, type: ParamType): string;
  /** Convert an epoch-ms timestamp into the value bound for a `timestamp` param. */
  timestampValue(epochMs: number): unknown;
  /** Aggregate: the `q`-quantile (0..1) of `expr`. */
  quantile(expr: string, q: number): string;
  /** L2 (Euclidean) norm of an array-valued `expr`. */
  vectorNorm(expr: string): string;
  /** Conditional average: mean of `value` over rows where `cond` holds. */
  avgIf(value: string, cond: string): string;
  /** Aggregate: an arbitrary (any) value of `expr` within the group. */
  anyValue(expr: string): string;
  /**
   * Bucket timestamp column `tsExpr` into fixed windows of `intervalPlaceholder`
   * seconds and return the bucket start as epoch **milliseconds**.
   */
  timeBucketMs(tsExpr: string, intervalPlaceholder: string): string;
  /** Convert a timestamp expression into an integer epoch **milliseconds** value. */
  epochMs(tsExpr: string): string;
  /** Truncate a timestamp expression to a date. */
  toDate(expr: string): string;
  /** Cast an expression to text. */
  toText(expr: string): string;
  /**
   * Extract a nested string value from a JSON text column by key path, e.g.
   * `jsonText("payload", "scene", "cameraType")`. Used to filter on fields that
   * are not promoted to dedicated columns (they live only in the `payload` JSON).
   * Path components are trusted compile-time constants, never user input.
   */
  jsonText(column: string, ...path: string[]): string;
  // --- rollup merge combinators (AggregatingMergeTree on ClickHouse) ---
  countMerge(stateExpr: string): string;
  avgMerge(stateExpr: string): string;
  quantileMerge(stateExpr: string, q: number): string;
  /** ASOF inner-join keyword/clause introducer. */
  readonly asofInnerJoin: string;
  /**
   * ASOF left-join keyword/clause introducer. Like {@link asofInnerJoin} but
   * keeps left rows that have no matching right row (their right-side columns
   * are NULL on DuckDB and engine defaults on ClickHouse), so callers must guard
   * unmatched rows explicitly.
   */
  readonly asofLeftJoin: string;
}

/**
 * Accumulates bound parameters while a query is rendered, delegating placeholder
 * syntax and value coercion to the {@link Dialect}. One bag per built query.
 */
export class ParamBag {
  readonly values: Record<string, unknown> = {};

  constructor(private readonly dialect: Dialect) {}

  /** Bind `value` to `name` (typed) and return its placeholder for the SQL text. */
  add(name: string, type: ParamType, value: unknown): string {
    this.values[name] = type === "timestamp" ? this.dialect.timestampValue(value as number) : value;
    return this.dialect.placeholder(name, type);
  }
}

/** Build a `ts` range predicate (epoch-ms bounds), or `""` when unbounded. */
export function rangeClause(bag: ParamBag, opts: RangeOptions): string {
  const parts: string[] = [];
  if (opts.since != null) parts.push(`ts >= ${bag.add("since", "timestamp", opts.since)}`);
  if (opts.until != null) parts.push(`ts < ${bag.add("until", "timestamp", opts.until)}`);
  return parts.length ? ` AND ${parts.join(" AND ")}` : "";
}

/** Build a `day` range predicate (for rollup tables), or `""` when unbounded. */
export function dayRangeClause(bag: ParamBag, dialect: Dialect, opts: RangeOptions): string {
  const parts: string[] = [];
  if (opts.since != null) {
    parts.push(`day >= ${dialect.toDate(bag.add("since", "timestamp", opts.since))}`);
  }
  if (opts.until != null) {
    parts.push(`day < ${dialect.toDate(bag.add("until", "timestamp", opts.until))}`);
  }
  return parts.length ? ` AND ${parts.join(" AND ")}` : "";
}

/** Build a `scene_id` equality predicate, or `""` when no scene is given. */
export function sceneClause(bag: ParamBag, opts: SceneOptions): string {
  if (opts.scene == null || opts.scene.length === 0) return "";
  return ` AND scene_id = ${bag.add("scene", "string", opts.scene)}`;
}

/** Build a `source` equality predicate, or `""` when no source is given. */
export function sourceClause(bag: ParamBag, opts: SourceOptions): string {
  if (opts.source == null || opts.source.length === 0) return "";
  return ` AND source = ${bag.add("source", "string", opts.source)}`;
}

/** Build a `session_id` equality predicate, or `""` when no session is given. */
export function sessionClause(bag: ParamBag, opts: SessionOptions): string {
  if (opts.session == null || opts.session.length === 0) return "";
  return ` AND session_id = ${bag.add("session", "string", opts.session)}`;
}

/**
 * Build a world-space region (AABB) predicate (ADR 0040 §4): restrict a spatial
 * heatmap to the box `[minX, minY, minZ, maxX, maxY, maxZ]`, inclusive on both
 * ends. `cols` names the SQL column expressions for the x/y/z coordinate of the
 * point being filtered (e.g. `hit_point[1]` for world/gaze, `position[1]` for the
 * floor plan). Returns `""` when no region is given. Degenerate boxes (`max < min`
 * on any axis) are passed through verbatim — the caller validates at the boundary.
 */
export function regionClause(
  bag: ParamBag,
  opts: RegionOptions,
  cols: { x: string; y: string; z: string },
): string {
  const r = opts.region;
  if (r == null) return "";
  const [minX, minY, minZ, maxX, maxY, maxZ] = r;
  const parts = [
    `${cols.x} >= ${bag.add("regMinX", "f64", minX)}`,
    `${cols.x} <= ${bag.add("regMaxX", "f64", maxX)}`,
    `${cols.y} >= ${bag.add("regMinY", "f64", minY)}`,
    `${cols.y} <= ${bag.add("regMaxY", "f64", maxY)}`,
    `${cols.z} >= ${bag.add("regMinZ", "f64", minZ)}`,
    `${cols.z} <= ${bag.add("regMaxZ", "f64", maxZ)}`,
  ];
  return ` AND ${parts.join(" AND ")}`;
}

/**
 * Build a camera-mode predicate (ADR 0026): restrict to sessions whose
 * `session_start` declares the given `scene.cameraType`. Rendered as a
 * `session_id IN (sub-select)` so it composes with the other clauses; returns
 * `""` when no camera type is requested. `projectId` is bound again here so the
 * sub-select is scoped to the same project as the outer query.
 */
export function cameraModeClause(
  bag: ParamBag,
  d: Dialect,
  projectId: string,
  opts: CameraModeOptions,
): string {
  if (opts.cameraType == null || opts.cameraType.length === 0) return "";
  const pid = bag.add("cmProjectId", "string", projectId);
  const ct = bag.add("cameraType", "string", opts.cameraType);
  const extract = d.jsonText("payload", "scene", "cameraType");
  return ` AND session_id IN (
        SELECT session_id FROM events
        WHERE project_id = ${pid} AND event_type = 'session_start' AND ${extract} = ${ct}
      )`;
}
