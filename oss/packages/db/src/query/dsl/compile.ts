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
  queryTier,
  type FilterId,
  type MetricDefinition,
  type MetricId,
  type QueryTier,
} from "@uptimizr/metrics";
import type { QueryV1 } from "@uptimizr/schema";
import type { Dialect } from "../dialect.js";
import type { QuerySpec, WorldAabb } from "../types.js";
import { builderFor } from "./builders.js";
import { compileGenericGroupBy, type GenericQueryOptions } from "./generic.js";

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
  tier: QueryTier = "delegated",
): MetricQueryOptions {
  const options: Record<string, unknown> = {
    since: query.range.since,
    until: query.range.until,
  };

  for (const [key, value] of Object.entries(query.filters ?? {})) {
    if (value === undefined) continue;
    // The two generic-tier filters are not builder options at all: no `build*`
    // takes an event predicate or a device attribute. They ride in the bag under
    // their own names and are read by the generic builder alone.
    if (key === "event" || key === "device") {
      if (tier === "generic") options[key] = value;
      continue;
    }

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

  // A `segment` is a set of equality filters with a name. Where the metric
  // already has a filter for the dimension, it *is* that filter — so it lands on
  // the same option field and a delegated query never has to know the difference.
  // Anything else is a dimension only the generic builder can hold fixed.
  const segment: Record<string, string> = {};
  for (const [dimension, value] of Object.entries(query.segment ?? {})) {
    const target = FILTER_TARGETS[dimension as FilterId];
    if (target != null) {
      if (dimension === "cameraMode") {
        assign(options, target.field, cameraTypeForMode(value as "viewer" | "first-person"));
      } else {
        assign(options, target.field, value);
      }
      continue;
    }
    segment[dimension] = value;
  }

  if (query.limit != null) options.limit = query.limit;
  if (resolved.cellSize != null && options.cellSize == null) options.cellSize = resolved.cellSize;

  if (tier === "generic") {
    // The generic builder reads its grain, its order and its segment from the
    // same bag; `compileMetric` dispatches on `tier`, which is the one field
    // that is about compilation rather than about the query.
    options.tier = "generic";
    options.dimensions = query.dimensions == null ? undefined : [...query.dimensions];
    if (query.order != null) options.order = { ...query.order };
    if (Object.keys(segment).length > 0) options.segment = segment;
  }

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
  // `tier` is the one field of the bag that describes the *compilation* rather
  // than the query, and it is set only by `toBuilderOptions` after
  // `validateQuery` decided the metric can answer at another grain. A store
  // calling `runMetric` with a plain option bag therefore keeps the delegated
  // behaviour it has always had.
  if (options.tier === "generic") {
    return compileGenericGroupBy(
      definition,
      projectId,
      options as unknown as GenericQueryOptions,
      dialect,
    );
  }
  return builderFor(definition.builder)(projectId, { ...options }, dialect);
}

/**
 * Compile a validated query end to end: filters → option bag → the metric's
 * builder (or the generic one) → a `QuerySpec`.
 *
 * The tier is derived here rather than passed in, so a caller that has a
 * validated query cannot compile it onto the wrong compiler; the collector,
 * which already has the tier from `validateQuery`, may pass it to save the
 * lookup.
 */
export function compileQuery(
  projectId: string,
  query: QueryV1,
  dialect: Dialect,
  resolved: QueryResolution = {},
  tier?: QueryTier,
): QuerySpec {
  const definition = getMetric(query.metric as MetricId);
  const effective = tier ?? (definition == null ? "delegated" : queryTier(definition, query));
  return compileMetric(
    query.metric as MetricId,
    projectId,
    toBuilderOptions(query, resolved, effective),
    dialect,
  );
}
