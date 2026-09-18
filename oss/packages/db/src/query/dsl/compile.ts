/**
 * **The delegated query compiler** (ADR 0051 §3, design sketch §C.2, tier 1).
 *
 * A validated `queryV1` document becomes a `QuerySpec` by way of the metric's
 * *existing* aggregation builder: the registry says which `build*` computes the
 * metric, `FILTER_TARGETS` says which option field each filter drives, and the
 * builder renders the SQL it has always rendered, through the same `Dialect`.
 *
 * That is the point of the delegated tier. Every registry metric is reachable
 * through the DSL on day one at exactly the power its canned endpoint has — no
 * second SQL path, no "DSL-only" subset of metrics, and nothing new for the
 * cross-engine parity harness to cover, because the specs it compiles *are* the
 * specs the parity cases already pin (`src/__tests__/queryDsl.test.ts` asserts
 * that equality builder by builder, on all four dialects).
 *
 * It also means the DSL inherits the two properties that matter most and cannot
 * be bolted on afterwards: every value reaches SQL as a bound parameter (the
 * builders' `ParamBag`), and the returned spec carries its `metric`, so the
 * store edge coerces the rows (`coerceRows`, ADR 0051 §2) without knowing a DSL
 * exists.
 *
 * What this module does **not** do: validate. A query must already have passed
 * `queryV1Schema` (shape) and `validateQuery` (vocabulary) — by the time it gets
 * here, the metric exists, has a builder, accepts every filter named, and asks
 * for a grain it can produce. The two `throw`s below are guards against a caller
 * skipping that, not a client-facing error path.
 */

import {
  FILTER_TARGETS,
  getMetric,
  type FilterId,
  type MetricDefinition,
  type MetricId,
} from "@uptimizr/metrics";
import type { QueryV1 } from "@uptimizr/schema";
import type { Dialect } from "../dialect.js";
import type { QuerySpec, WorldAabb } from "../types.js";
import { builderFor } from "./builders.js";

/**
 * The option bag an aggregation builder takes, assembled from a query. Loosely
 * typed for the reason given on {@link import("./builders.js").AggregationBuilder}:
 * each builder's own options are a different intersection, and what makes the
 * bag correct is registry validation upstream, not a type here.
 */
export type MetricQueryOptions = Readonly<Record<string, unknown>>;

/**
 * The dashboard's camera-mode toggle → the `scene.cameraType` the events carry
 * (ADR 0026). The same mapping the canned routes apply; it lives here too so a
 * DSL query and a `?cameraMode=` request produce the identical spec.
 */
export function cameraTypeForMode(mode: "viewer" | "first-person" | undefined): string | undefined {
  if (mode === "first-person") return "free";
  if (mode === "viewer") return "arc-rotate";
  return undefined;
}

/**
 * Values a query cannot carry on its own and the caller resolves first.
 *
 * `region` may be the **id** of a registered scene region (ADR 0051 §2), which
 * only a store can turn into bounds, and `cellSize` may be derived from the
 * scene's registered extent when the caller did not pin one (ADR 0040 §1). Both
 * are looked up by the collector before compilation, exactly as the canned
 * spatial routes do, and passed in here.
 */
export interface QueryResolution {
  /** Bounds for a `filters.region` given as a region id. */
  region?: WorldAabb;
  /** The effective voxel edge, when the caller left `cellSize` to the collector. */
  cellSize?: number;
}

/**
 * Assign `value` to `field` on the option bag. Almost every `FILTER_TARGETS`
 * field is a plain property name; the three `center[i]` entries address one
 * element of a tuple option (the reference point `camera_distance` measures
 * from), which is the only indexed form the registry uses.
 */
function assign(options: Record<string, unknown>, field: string, value: unknown): void {
  const indexed = /^([A-Za-z0-9_]+)\[(\d+)\]$/.exec(field);
  if (!indexed) {
    options[field] = value;
    return;
  }
  const [, name, index] = indexed as unknown as [string, string, string];
  const tuple = Array.isArray(options[name]) ? (options[name] as unknown[]) : [];
  tuple[Number(index)] = value;
  options[name] = tuple;
}

/**
 * Turn a validated query into the option bag its builder takes.
 *
 * The mapping is the registry's, not this file's: for each filter the query
 * carries, `FILTER_TARGETS[filter].field` names the option field it drives. Only
 * two values are transformed on the way — the camera-mode toggle becomes the
 * stored `cameraType`, and a region id becomes the bounds the caller resolved.
 */
export function toBuilderOptions(
  query: QueryV1,
  resolved: QueryResolution = {},
): MetricQueryOptions {
  const options: Record<string, unknown> = {
    since: query.range.since,
    until: query.range.until,
  };

  for (const [key, value] of Object.entries(query.filters ?? {})) {
    if (value === undefined) continue;
    // Grammar keys with no delegated implementation (#304). `validateQuery`
    // has already rejected them; skipped here so this function stays total.
    if (key === "event" || key === "device") continue;

    const target = FILTER_TARGETS[key as FilterId];
    if (!target) continue;

    if (key === "cameraMode") {
      assign(options, target.field, cameraTypeForMode(value as "viewer" | "first-person"));
      continue;
    }
    if (key === "region") {
      const region = typeof value === "string" ? resolved.region : (value as WorldAabb);
      if (region == null) {
        throw new Error(
          "filters.region names a registered region id, which must be resolved to bounds before compiling",
        );
      }
      assign(options, target.field, region);
      continue;
    }
    assign(options, target.field, value);
  }

  if (query.limit != null) options.limit = query.limit;
  if (resolved.cellSize != null && options.cellSize == null) options.cellSize = resolved.cellSize;

  return options;
}

/**
 * Render the `QuerySpec` for one metric and an already-assembled option bag.
 *
 * This is the seam the stores use: a store's `runMetric` is exactly
 * `run<Engine>Query(compileMetric(metric, projectId, options, <engine>Dialect))`,
 * so the DSL reaches every engine through the one code path aggregations already
 * take — and therefore through the same parity harness and the same numeric
 * coercion.
 */
export function compileMetric(
  metric: MetricId,
  projectId: string,
  options: MetricQueryOptions,
  dialect: Dialect,
): QuerySpec {
  const definition: MetricDefinition | undefined = getMetric(metric);
  if (!definition?.builder) {
    throw new Error(`metric '${metric}' has no aggregation builder and cannot be compiled`);
  }
  return builderFor(definition.builder)(projectId, { ...options }, dialect);
}

/**
 * Compile a validated query end to end: filters → option bag → the metric's
 * builder → a `QuerySpec`.
 */
export function compileQuery(
  projectId: string,
  query: QueryV1,
  dialect: Dialect,
  resolved: QueryResolution = {},
): QuerySpec {
  return compileMetric(
    query.metric as MetricId,
    projectId,
    toBuilderOptions(query, resolved),
    dialect,
  );
}
