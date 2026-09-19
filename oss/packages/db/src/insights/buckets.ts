/**
 * **The one generic bucket query** behind both insight primitives
 * (ADR 0051 §4, design sketch §D).
 *
 * `buildMetricBuckets` renders a {@link BucketMeasure} — the declarative
 * description of how a comparable metric's primary column is reproduced per
 * time bucket, from `measures.ts` — into a single grouped scan of `events`:
 *
 * ```sql
 * SELECT <time bucket> AS bucket, <aggregate> AS value, <denominator> AS sample_size
 * FROM events
 * WHERE project_id = ? AND event_type IN (…) AND …
 * GROUP BY bucket ORDER BY bucket ASC
 * ```
 *
 * It is authored against the {@link Dialect} interface like every aggregation in
 * `query/aggregations.ts`, and parity-tested on all four engines through
 * `src/parity/cases.ts`. It deliberately does **not** live in
 * `query/aggregations.ts`: the `build*` exports of that module are the registry's
 * closed list of *metrics*, each of which must have its own registry entry and
 * endpoint. This is not a metric — it is the shared input of two, and has no
 * endpoint, no row schema and no tool of its own. Keeping it here keeps the
 * registry's coverage invariant meaningful.
 *
 * No statistic is computed in SQL. The query returns raw per-bucket values and
 * everything else — mean, median, MAD, quantiles, slope, robust z — is pure
 * TypeScript in `stats.ts`, so no two engines can disagree about an insight.
 */

import type { Dialect } from "../query/dialect.js";
import { ParamBag, rangeClause, sceneClause } from "../query/dialect.js";
import type { QuerySpec, RangeOptions, SceneOptions } from "../query/types.js";
import {
  BUCKET_SECONDS,
  bucketMeasureFor,
  type BucketAggregate,
  type BucketGrain,
  type BucketMeasure,
  type BucketPredicate,
  type BucketValueColumn,
} from "./measures.js";

/** What to bucket, over what window, for whom. */
export interface MetricBucketOptions extends RangeOptions, SceneOptions {
  /** The registry metric whose primary column the series reproduces. */
  metric: string;
  /** Time grain; defaults to `day`. */
  bucket?: BucketGrain;
}

/**
 * One bucket of a metric's series, as the store returns it.
 *
 * `value` is nullable because an aggregate over no matching rows is SQL-`NULL`
 * (a bucket in which a `quantile` had nothing to rank), and `null` must reach
 * the statistics as "no observation" rather than as `0`. Buckets with no
 * matching events at all are simply absent — the series is sparse, and
 * `baseline`/`movers` treat absence as absence.
 */
export interface MetricBucketRow {
  /** Bucket start, epoch milliseconds (UTC, aligned to the grain). */
  bucket: number;
  /** The metric's primary column for this bucket, or `null` when undefined. */
  value: number | null;
  /** The denominator behind `value` — what `minSample` is compared against. */
  sample_size: number;
}

/** The SQL expression for a promoted value column, per aggregate. */
function valueColumnExpr(column: BucketValueColumn, aggregate: string, d: Dialect): string {
  switch (column) {
    case "fps":
      return "fps";
    case "visible_ms":
      return "visible_ms";
    case "js_heap_bytes":
      // A heap reading of 0 means "the browser did not report one" (the column
      // is `NOT NULL DEFAULT 0`), so averages and percentiles must exclude it —
      // exactly what `buildResourceSummary` / `buildResourcePercentiles` do. A
      // `max` keeps the raw column: the largest of a set that includes 0 is
      // unaffected by it, and nulling it out would only cost a branch.
      return aggregate === "max" ? "js_heap_bytes" : "nullIf(js_heap_bytes, 0)";
    case "ar_placement_scale":
      // Not promoted; read from the payload exactly as `buildArPlacementSurfaces`
      // reads it, so the bucket series and the metric agree.
      return d.jsonFloat("payload", "scale");
  }
}

/** The `SELECT` expression that produces a bucket's value. */
function aggregateExpr(aggregate: BucketAggregate, d: Dialect): string {
  switch (aggregate.kind) {
    case "count":
      return "count(*)";
    case "sessions":
      return "count(DISTINCT session_id)";
    case "sum":
      return `sum(${valueColumnExpr(aggregate.column, "sum", d)})`;
    case "avg":
      return `avg(${valueColumnExpr(aggregate.column, "avg", d)})`;
    case "max":
      return `max(${valueColumnExpr(aggregate.column, "max", d)})`;
    case "quantile":
      return d.quantile(valueColumnExpr(aggregate.column, "quantile", d), aggregate.q);
  }
}

/**
 * The `SELECT` expression for the bucket's denominator.
 *
 * For a session-valued measure the denominator *is* the distinct-session count
 * (`minSample: 30` on `view_coverage_histogram` means thirty sessions, not
 * thirty camera samples); for every other measure it is the number of events
 * that contributed.
 */
function sampleSizeExpr(aggregate: BucketAggregate): string {
  return aggregate.kind === "sessions" ? "count(DISTINCT session_id)" : "count(*)";
}

/** `AND event_type IN (…)`, or `""` when the measure counts every channel. */
function eventTypeClause(bag: ParamBag, measure: BucketMeasure): string {
  const types = measure.eventTypes;
  if (types.length === 0) return "";
  if (types.length === 1) {
    return ` AND event_type = ${bag.add("bmType0", "string", types[0])}`;
  }
  const placeholders = types.map((type, index) => bag.add(`bmType${index}`, "string", type));
  return ` AND event_type IN (${placeholders.join(", ")})`;
}

/**
 * One extra predicate, rendered from the closed vocabulary in `measures.ts`.
 *
 * Column names come from a compile-time union and values are always bound as
 * parameters, so nothing a caller can influence reaches the SQL text.
 */
function predicateClause(
  bag: ParamBag,
  d: Dialect,
  predicate: BucketPredicate,
  index: number,
): string {
  switch (predicate.kind) {
    case "eq":
      return ` AND ${predicate.column} = ${bag.add(`bmP${index}`, "string", predicate.value)}`;
    case "ne":
      return ` AND ${predicate.column} <> ${bag.add(`bmP${index}`, "string", predicate.value)}`;
    case "in": {
      const placeholders = predicate.values.map((value, i) =>
        bag.add(`bmP${index}_${i}`, "string", value),
      );
      return ` AND ${predicate.column} IN (${placeholders.join(", ")})`;
    }
    case "geometry":
      return ` AND ${d.arrayLength(predicate.column)} = ${predicate.arity}`;
  }
}

/**
 * Build the per-bucket series of a metric's comparable primary column.
 *
 * Throws when the metric has no portable bucket form — the route validates
 * against `BUCKETABLE_METRIC_IDS` at the edge and answers `400`, so reaching
 * this is a programming error rather than bad input.
 */
export function buildMetricBuckets(
  projectId: string,
  opts: MetricBucketOptions,
  d: Dialect,
): QuerySpec {
  const measure = bucketMeasureFor(opts.metric);
  if (measure == null) {
    throw new Error(`metric '${opts.metric}' has no portable bucket series`);
  }
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const seconds = BUCKET_SECONDS[opts.bucket ?? "day"];
  const interval = bag.add("bmInterval", "u32", seconds);
  const types = eventTypeClause(bag, measure);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const predicates = (measure.where ?? [])
    .map((predicate, index) => predicateClause(bag, d, predicate, index))
    .join("");

  return {
    query: `
      SELECT
        ${d.timeBucketMs("ts", interval)} AS bucket,
        ${aggregateExpr(measure.aggregate, d)} AS value,
        ${sampleSizeExpr(measure.aggregate)} AS sample_size
      FROM events
      WHERE project_id = ${pid}${types}${range}${scene}${predicates}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
    query_params: bag.values,
  };
}

/**
 * Normalise driver output into a {@link MetricBucketRow}.
 *
 * `buildMetricBuckets` produces no registry metric, so it carries no
 * `QuerySpec.metric` tag and the store-edge coercion (ADR 0051 §2) has no row
 * schema to coerce it against. ClickHouse string-encodes 64-bit counts over
 * HTTP, so the numbers are parsed here instead — the one place every store's
 * bucket read passes through.
 */
export function toMetricBucketRows(rows: readonly Record<string, unknown>[]): MetricBucketRow[] {
  const out: MetricBucketRow[] = [];
  for (const row of rows) {
    const bucket = toNumber(row.bucket);
    if (bucket == null) continue;
    out.push({
      bucket,
      value: toNumber(row.value),
      sample_size: toNumber(row.sample_size) ?? 0,
    });
  }
  return out.sort((a, b) => a.bucket - b.bucket);
}

/** A finite number from a driver cell, or `null`. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
