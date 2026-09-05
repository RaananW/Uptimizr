/**
 * Dialect-agnostic query layer (ADR 0020).
 *
 * Each analytics aggregation is authored *once* in `aggregations.ts` against the
 * {@link Dialect} interface, and rendered to a {@link QuerySpec} per SQL engine.
 * Everything that genuinely differs between engines — bound-parameter syntax,
 * `quantile`, vector norm, array length, time bucketing, ASOF joins, and the
 * rollup `-Merge` combinators — is funnelled through this interface so the bulk
 * of each query stays shared. The OSS default engine is DuckDB; the single-tenant
 * ClickHouse, Postgres and SQL Server dialects serve self-hosters who outgrow
 * DuckDB's single-writer file (`@uptimizr/db-clickhouse`, `@uptimizr/db-postgres`,
 * `@uptimizr/db-mssql`).
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
  MeshOptions,
  RegionOptions,
} from "./types.js";

export type { QuerySpec };

/** Logical bound-parameter type, mapped to an engine-specific type by the dialect. */
export type ParamType = "string" | "u32" | "f64" | "timestamp" | "date";

/**
 * Structured description of an ASOF join — "for every left row, the single
 * right row with the same keys whose timestamp is nearest in the given
 * direction". Authored once per aggregation; each dialect renders it either as
 * a native `ASOF JOIN` (DuckDB, ClickHouse) or as a correlated nearest-row
 * subquery (`LATERAL` + `LIMIT 1` on Postgres, `CROSS/OUTER APPLY` + `TOP 1` on
 * SQL Server) — see `relational.ts`.
 *
 * `leftTs` and the left side of `keys` are expressions qualified with the *left*
 * alias (the caller owns that alias); `rightTs` and the right side of `keys` are
 * bare column names of the right relation, which the dialect qualifies with
 * `alias`.
 */
export interface AsofJoinSpec {
  /** `inner` drops unmatched left rows; `left` keeps them with NULL right columns. */
  readonly kind: "inner" | "left";
  /**
   * The right relation: a parenthesised subquery (`(SELECT …)`) or a bare table
   * / CTE name. Must not carry its own alias — the dialect applies `alias`.
   */
  readonly right: string;
  /** Alias the right relation's columns are read through in the outer query. */
  readonly alias: string;
  /** Equality keys as `[leftExpr, rightColumn]` pairs (at least one). */
  readonly keys: ReadonlyArray<readonly [left: string, right: string]>;
  /** Left-side timestamp expression (qualified). */
  readonly leftTs: string;
  /**
   * Comparison `leftTs <op> rightTs`: `>=`/`>` select the nearest *preceding*
   * right row, `<=`/`<` the nearest *following* one.
   */
  readonly op: ">=" | ">" | "<=" | "<";
  /** Right-side timestamp column (bare name). */
  readonly rightTs: string;
}

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
  /**
   * Number of elements in an array-valued `expr` (0 for an empty array). Used
   * to guard vector columns (`arrayLength("position") = 3`) before indexing
   * them; element indexing itself (`position[1]`) is 1-based on every supported
   * engine and stays inline in the shared SQL (SQL Server, which has no arrays,
   * rewrites it to JSON extraction at execution time — see `toTsql`).
   */
  arrayLength(expr: string): string;
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
  /**
   * Extract a nested **nullable integer** value from a JSON text column by key
   * path, e.g. `jsonInt("payload", "count")`. Returns NULL when the key is absent
   * or not integer-coercible, so callers can `coalesce(..., default)`. Used for
   * numeric fields that are not promoted to dedicated columns (they live only in
   * the `payload` JSON). Path components are trusted compile-time constants.
   */
  jsonInt(column: string, ...path: string[]): string;
  /**
   * Extract a nested **nullable float** value from a JSON text column by key
   * path, e.g. `jsonFloat("payload", "uv", "0")`. Numeric path components index
   * into a JSON array (0-based, dialect-normalized). Returns NULL when the key is
   * absent or not numeric, so callers can filter or coalesce. Used for float
   * fields that live only in the `payload` JSON (e.g. texture-space `uv`, #149).
   * Path components are trusted compile-time constants, never user input.
   */
  jsonFloat(column: string, ...path: string[]): string;
  // --- rollup merge combinators (AggregatingMergeTree on ClickHouse) ---
  countMerge(stateExpr: string): string;
  avgMerge(stateExpr: string): string;
  quantileMerge(stateExpr: string, q: number): string;
  /**
   * Render an ASOF join clause (`… JOIN <right> AS <alias> ON …`) from a
   * structured {@link AsofJoinSpec}, placed directly after the left relation.
   * A `left` join keeps left rows that have no matching right row (their
   * right-side columns are NULL on DuckDB/Postgres and engine defaults on
   * ClickHouse), so callers must guard unmatched rows explicitly.
   */
  asofJoin(spec: AsofJoinSpec): string;
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

/** Build a `mesh` equality predicate, or `""` when no mesh is given (#149). */
export function meshClause(bag: ParamBag, opts: MeshOptions): string {
  if (opts.mesh == null || opts.mesh.length === 0) return "";
  return ` AND mesh = ${bag.add("mesh", "string", opts.mesh)}`;
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
