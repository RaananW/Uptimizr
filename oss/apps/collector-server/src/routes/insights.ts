/**
 * **Insight primitives** — `GET /api/v1/insights/*` (ADR 0051 §4, sketch §D).
 *
 * Two registry metrics that answer the questions an agent otherwise re-derives
 * from raw rows on every turn:
 *
 * - `insight_baseline` — what is normal for one metric in one scene;
 * - `insight_movers` — what changed, ranked by how unusual the change is.
 *
 * The plugin is deliberately thin (ADR 0005). Everything that decides an answer
 * lives in `@uptimizr/db`'s pure `src/insights/`: which metrics have a portable
 * bucket series, how the window resolves, and every statistic. This file does
 * three things — validate at the boundary, fan the bucket reads out under a
 * declared cap, and shape the envelope.
 *
 * It is a separate plugin rather than more routes in `query.ts` because it is a
 * separate *kind* of read: a derived metric composed of other metrics' series,
 * which needs its own error vocabulary (a metric can be unknown, not comparable,
 * or comparable but not bucketable — three different 400s) and its own bounded
 * fan-out. One registration line in `app.ts` is the whole coupling.
 */

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  BUCKETABLE_METRIC_IDS,
  // --- significance / scene health (#307) ---
  HEALTH_DEFAULT_SCENES,
  HEALTH_FACTORS,
  HEALTH_FACTOR_IDS,
  HEALTH_MAX_SCENES,
  bucketVariantFor,
  computeSceneHealth,
  computeSignificance,
  rankSceneHealth,
  resolveHealthWindows,
  type BucketVariant,
  type HealthFactorInput,
  type SceneHealthRow,
  type SignificanceRow,
  MOVERS_DEFAULT_METRICS,
  MOVERS_MAX_METRICS,
  bucketMeasureFor,
  computeBaseline,
  inWindow,
  isBucketableMetric,
  rankMovers,
  resolveBaselineWindow,
  resolveMoversWindows,
  resultEnvelopeSchema,
  resultFormatSchema,
  spanningWindow,
  summarizeRows,
  tableResult,
  type BaselineRow,
  type BucketGrain,
  type MetricBucketRow,
  type MoverInput,
  type MoverRow,
  type ResolvedWindow,
  type ResultFormat,
  type SummaryContext,
} from "@uptimizr/db";
import { allMetrics, getMetric, type MetricDefinition, type MetricId } from "@uptimizr/metrics";
import type { CollectorStore } from "../store.js";
import { requireCapability } from "../auth.js";

interface Options {
  store: CollectorStore;
}

/**
 * How many bucket reads run at once.
 *
 * `movers` issues one grouped scan per scanned metric. Firing all of them at
 * once would open more concurrent statements than a single-file DuckDB or a
 * small Postgres pool wants; running them one at a time would pay the full
 * round-trip latency 24 times. A small fixed pool is the compromise, and it is
 * a constant rather than a setting because the cap on metrics per request
 * (`MOVERS_MAX_METRICS`) already bounds the total work.
 */
const BUCKET_READ_CONCURRENCY = 4;

/** Developer-assigned scene/area filter (ADR 0010) — same shape as `query.ts`. */
const sceneFilter = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/)
  .optional();

/** The insight time grain. Not the FPS histogram's `bucket`, which is a number. */
const bucketFilter = z.enum(["day", "hour"]).optional();

/** Result envelope (ADR 0051 §2) — every registry-served aggregate accepts it. */
const formatFilter = resultFormatSchema.optional();

/**
 * `GET /api/v1/insights/baseline` parameters.
 *
 * `metric` is validated as a bounded identifier here and resolved against the
 * registry in the handler, so the 400 can *name the alternatives* instead of
 * emitting an opaque enum-mismatch message — the difference between an agent
 * that recovers on the next turn and one that retries the same call.
 */
const baselineQueryParams = z.object({
  metric: z.string().min(1).max(64),
  scene: sceneFilter,
  window: z.coerce.number().int().positive().max(365).optional(),
  bucket: bucketFilter,
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  format: formatFilter,
});

/**
 * `GET /api/v1/insights/movers` parameters.
 *
 * `metrics` is a comma-separated allowlist. It is capped at
 * {@link MOVERS_MAX_METRICS} by the schema itself, so an over-long list is a
 * validation error rather than a silently truncated scan — a caller must never
 * be told "nothing moved" about metrics that were never looked at.
 */
const moversQueryParams = z.object({
  scene: sceneFilter,
  metrics: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .transform((value, ctx): string[] | undefined => {
      if (value == null) return undefined;
      const ids = value
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      if (ids.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "metrics must name at least one id" });
        return z.NEVER;
      }
      if (ids.length > MOVERS_MAX_METRICS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `metrics is capped at ${MOVERS_MAX_METRICS} ids per request`,
        });
        return z.NEVER;
      }
      return [...new Set(ids)];
    }),
  bucket: bucketFilter,
  limit: z.coerce.number().int().positive().max(50).optional(),
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  refSince: z.coerce.number().int().optional(),
  refUntil: z.coerce.number().int().optional(),
  format: formatFilter,
});

/** `{ error, … }` body the insight routes send for a rejected metric. */
const badRequestResponse = z.object({
  error: z.string(),
  metric: z.string().optional(),
  comparable: z.array(z.string()).optional(),
  available: z.array(z.string()).optional(),
});

/** The registry entry for an insight route, resolved once at startup. */
function metricFor(id: MetricId): MetricDefinition {
  const metric = getMetric(id);
  // Startup-time failure: this plugin exists to serve these two entries.
  if (metric == null) throw new Error(`no registry metric '${id}'`);
  return metric;
}

const BASELINE = metricFor("insight_baseline");
const MOVERS = metricFor("insight_movers");

/** 200 response schema for an insight route: rows, or either envelope. */
function rowsFor(metric: MetricDefinition): z.ZodType<unknown[]> {
  return resultEnvelopeSchema(z.array(metric.row), metric.row) as unknown as z.ZodType<unknown[]>;
}

/** Every comparable registry metric id, sorted — quoted back in a 400. */
const COMPARABLE_METRIC_IDS: readonly string[] = allMetrics()
  .filter((metric) => metric.comparable != null)
  .map((metric) => metric.id)
  .sort();

/** Why a requested metric cannot be turned into a bucket series. */
type MetricRejection = z.infer<typeof badRequestResponse>;

/**
 * Resolve a caller-supplied metric id to something a series can be built from.
 *
 * Three distinct failures, each with its own remedy, because collapsing them
 * into one "bad metric" message is what makes an agent loop:
 *
 * - **unknown** — a typo or a hallucinated id; the fix is a different name;
 * - **not comparable** — a real metric with no single headline column (a
 *   trajectory, a representation); the fix is a different *metric*, so the
 *   comparable ids are listed;
 * - **not bucketable** — comparable, but its value is defined by a join, a
 *   window function or a caller-supplied predicate and so has no faithful
 *   per-bucket form (see `measures.ts`); the fix is one of the ids that do.
 */
function resolveSeriesMetric(id: string): MetricDefinition | MetricRejection {
  const metric = getMetric(id);
  if (metric == null) {
    return {
      error: `unknown metric '${id}'`,
      metric: id,
      available: [...BUCKETABLE_METRIC_IDS],
    };
  }
  if (metric.comparable == null) {
    return {
      error:
        `metric '${id}' declares no comparable measure, so it has no single value to baseline ` +
        `or compare`,
      metric: id,
      comparable: [...COMPARABLE_METRIC_IDS],
    };
  }
  if (!isBucketableMetric(id)) {
    return {
      error:
        `metric '${id}' is comparable but has no portable bucket series (its value is defined by ` +
        `a join, a window function or a caller-supplied predicate), so it cannot be bucketed ` +
        `without changing what it means`,
      metric: id,
      comparable: [...COMPARABLE_METRIC_IDS],
      available: [...BUCKETABLE_METRIC_IDS],
    };
  }
  return metric;
}

function isRejection(value: MetricDefinition | MetricRejection): value is MetricRejection {
  return "error" in value;
}

/** Run `task` over `items` with at most `limit` in flight, preserving order. */
async function mapPooled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      out[index] = await task(items[index] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Split one spanning series into the two windows a mover compares. */
function partition(
  rows: readonly MetricBucketRow[],
  range: ResolvedWindow,
  reference: ResolvedWindow,
): { current: MetricBucketRow[]; reference: MetricBucketRow[] } {
  const current: MetricBucketRow[] = [];
  const previous: MetricBucketRow[] = [];
  for (const row of rows) {
    if (inWindow(row.bucket, range)) current.push(row);
    else if (inWindow(row.bucket, reference)) previous.push(row);
  }
  return { current, reference: previous };
}

/**
 * Everything the summariser needs about the request that produced the rows.
 *
 * The **resolved** window is echoed rather than the raw querystring, because
 * the bounds were snapped to whole buckets — a caller reading `range` in the
 * envelope must see the window that was actually measured.
 */
function summaryContextFor(
  metric: MetricDefinition,
  request: FastifyRequest,
  range: ResolvedWindow,
): SummaryContext {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const filters: Record<string, unknown> = { ...query, since: range.since, until: range.until };
  // `metrics` arrives parsed as an array; render it back to the comma list the
  // caller sent, so the echoed filters are a valid querystring value.
  if (Array.isArray(filters.metrics)) filters.metrics = filters.metrics.join(",");
  return {
    range: { since: range.since, until: range.until },
    filters,
  };
}

// =========================================================================
// --- significance / scene health (#307) ----------------------------------
//
// Two more derived metrics on the same plugin. They add no new *kind* of
// coupling: the same capability check, the same bounded fan-out over
// `store.metricBuckets`, the same `format` hook. What is new is only what the
// pure layer in `@uptimizr/db`'s `src/insights/` does with the series after it
// comes back.
// =========================================================================

const SIGNIFICANCE = metricFor("insight_significance");
const SCENE_HEALTH = metricFor("insight_scene_health");

/**
 * `GET /api/v1/insights/significance` parameters.
 *
 * `segment` / `refSegment` are accepted **in order to be refused**. Sketch §D
 * allows a segment-versus-segment contrast, so an agent that has read the
 * design will try one; a `400` naming the window parameters is a far better
 * answer than a silently dropped parameter and a comparison of the wrong two
 * things.
 */
const significanceQueryParams = z.object({
  metric: z.string().min(1).max(64),
  scene: sceneFilter,
  bucket: bucketFilter,
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  refSince: z.coerce.number().int().optional(),
  refUntil: z.coerce.number().int().optional(),
  format: formatFilter,
});

/**
 * Parameters the sketch allows but v1 cannot honour.
 *
 * They are deliberately **not** in the querystring schema — the registry
 * `filters` list is the contract, and advertising a parameter that always fails
 * would be worse than not having it. But an agent that has read sketch §D will
 * try one, so the raw querystring is checked and the answer names what to use
 * instead. Silently dropping the parameter would compare the wrong two things
 * and report a p-value for it.
 */
const UNSUPPORTED_SIGNIFICANCE_PARAMS = ["segment", "refSegment"] as const;

/** The first unsupported parameter present in a request’s raw querystring. */
function unsupportedParam(request: FastifyRequest): string | undefined {
  const query = (request.raw.url ?? "").split("?")[1];
  if (query == null || query.length === 0) return undefined;
  const params = new URLSearchParams(query);
  return UNSUPPORTED_SIGNIFICANCE_PARAMS.find((name) => params.has(name));
}

/**
 * `GET /api/v1/insights/scene-health` parameters.
 *
 * `weights` is a JSON object, parsed and validated here rather than in the pure
 * layer: an unknown factor id deserves a `400` naming the ids that exist, and
 * by the time the value reaches `computeSceneHealth` it is an ordinary record
 * of non-negative numbers.
 */
const sceneHealthQueryParams = z.object({
  scene: sceneFilter,
  window: z.coerce.number().int().positive().max(90).optional(),
  bucket: bucketFilter,
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(HEALTH_MAX_SCENES).optional(),
  weights: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .transform((value, ctx): Record<string, number> | undefined => {
      if (value == null) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'weights must be a JSON object, e.g. {"error_rate":0.5}',
        });
        return z.NEVER;
      }
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "weights must be a JSON object" });
        return z.NEVER;
      }
      const out: Record<string, number> = {};
      for (const [id, weight] of Object.entries(parsed as Record<string, unknown>)) {
        if (!HEALTH_FACTOR_IDS.includes(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown health factor '${id}'; the factors are ${HEALTH_FACTOR_IDS.join(", ")}`,
          });
          return z.NEVER;
        }
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `weight for '${id}' must be a number >= 0`,
          });
          return z.NEVER;
        }
        out[id] = weight;
      }
      return out;
    }),
  format: formatFilter,
});

/**
 * Whether a metric's headline column is a **declared rate**: its
 * `comparable.primary` names a `rateOf` denominator *and* the bucket catalog
 * carries the series that reproduces that denominator per bucket.
 *
 * Both halves are required. The registry alone says the number is a share of
 * something; the catalog alone says a second series exists. Only together do
 * they license a two-proportion test.
 */
function isDeclaredRate(metric: MetricDefinition): boolean {
  const primary = metric.comparable?.primary;
  if (primary == null) return false;
  if (metric.columns[primary]?.rateOf == null) return false;
  return bucketVariantFor(metric.id, "denominator") != null;
}

/**
 * Whether a measure **counts events** — the property that separates the two
 * discrete tests from Welch's t. A `count` or distinct-`sessions` aggregate
 * counts things that happened; a `sum`, `avg`, `max` or `quantile` is a level,
 * and a level is compared with a t-test whatever its unit.
 */
function isCountingMeasure(metric: MetricId): boolean {
  const kind = bucketMeasureFor(metric)?.aggregate.kind;
  return kind === "count" || kind === "sessions";
}

/** What one unit of a metric's headline column is, for `effectUnit`. */
function unitOf(metric: MetricDefinition): string {
  const primary = metric.comparable?.primary;
  return (primary == null ? undefined : metric.columns[primary]?.unit) ?? "value";
}

/** One bucket read in a `scene-health` fan-out. */
interface HealthRead {
  /** `''` for the project-wide baseline read. */
  scene: string;
  factor: string;
  side: "numerator" | "denominator";
  metric: MetricId;
  variant: BucketVariant | undefined;
  window: ResolvedWindow;
  /** Whether this read is the project baseline rather than the scene's window. */
  baseline: boolean;
}

/** The key a `HealthRead`'s rows are filed under. */
function readKey(read: HealthRead): string {
  return `${read.baseline ? "" : read.scene}|${read.factor}|${read.side}|${read.baseline ? "b" : "c"}`;
}

/** The sum of a series' finite values — the sessions behind a scored window. */
function seriesTotal(rows: readonly MetricBucketRow[] | undefined): number {
  let total = 0;
  for (const row of rows ?? []) {
    if (row.value != null && Number.isFinite(row.value)) total += row.value;
  }
  return total;
}

/**
 * Insight API. Every route is scoped to the authenticated project and needs the
 * ordinary `query` capability — an insight is a read of the project's own
 * telemetry, nothing more.
 */
export const insightRoutes: FastifyPluginAsync<Options> = async (app, { store }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** The resolved window of the request in flight, for the envelope hook. */
  const resolvedRanges = new WeakMap<FastifyRequest, ResolvedWindow>();

  /**
   * `format=table | summary` for the two derived metrics (ADR 0051 §2).
   *
   * The same job the hook in `query.ts` does for the aggregations, scoped to
   * this plugin — Fastify hooks are encapsulated, and these two metrics are not
   * in that plugin's path index because they carry no `build*` builder. The
   * shaping itself is `@uptimizr/db`'s pure, registry-driven `tableResult` /
   * `summarizeRows`, so neither handler knows the envelope exists.
   */
  app.addHook("preSerialization", async (request, reply, payload: unknown) => {
    if (reply.statusCode !== 200) return payload;
    const format = (request.query as { format?: ResultFormat } | undefined)?.format;
    if (format == null || format === "full") return payload;
    const metric = METRIC_BY_PATH.get(request.routeOptions.url ?? "");
    if (metric == null) return payload;
    const rows = (Array.isArray(payload) ? payload : payload == null ? [] : [payload]) as Record<
      string,
      unknown
    >[];
    const range = resolvedRanges.get(request) ?? { since: 0, until: 0 };
    const context = summaryContextFor(metric, request, range);
    const shaped =
      format === "table"
        ? tableResult(metric, rows, context)
        : summarizeRows(metric, rows, context);
    return shaped ?? payload;
  });

  /**
   * What is normal here. One row: the centre, spread, range and drift of one
   * metric's bucket series over the window.
   */
  r.get(
    BASELINE.endpoint!.path,
    {
      schema: {
        querystring: baselineQueryParams,
        response: { 200: rowsFor(BASELINE), 400: badRequestResponse },
      },
    },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "query");
      if (!resolved) return reply;

      const metric = resolveSeriesMetric(req.query.metric);
      if (isRejection(metric)) return reply.code(400).send(metric);

      const bucket: BucketGrain = req.query.bucket ?? "day";
      const range = resolveBaselineWindow({
        since: req.query.since,
        until: req.query.until,
        windowDays: req.query.window,
        bucket,
        now: Date.now(),
      });
      resolvedRanges.set(req, range);

      const rows = await store.metricBuckets(resolved.projectId, {
        metric: metric.id,
        bucket,
        since: range.since,
        until: range.until,
        scene: req.query.scene,
      });
      const baseline: BaselineRow = computeBaseline(metric.id, req.query.scene, rows);
      return [baseline];
    },
  );

  /**
   * What changed. One row per scanned metric, risers first, then fallers, then
   * the ones that did not move.
   */
  r.get(
    MOVERS.endpoint!.path,
    {
      schema: {
        querystring: moversQueryParams,
        response: { 200: rowsFor(MOVERS), 400: badRequestResponse },
      },
    },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "query");
      if (!resolved) return reply;

      // An explicit allowlist is validated id by id, so a single bad name is a
      // 400 naming it rather than a quietly shorter scan.
      const requested = req.query.metrics;
      const scanned: MetricDefinition[] = [];
      for (const id of requested ?? MOVERS_DEFAULT_METRICS) {
        const metric = resolveSeriesMetric(id);
        if (isRejection(metric)) return reply.code(400).send(metric);
        scanned.push(metric);
      }

      const bucket: BucketGrain = req.query.bucket ?? "day";
      const { range, reference } = resolveMoversWindows({
        since: req.query.since,
        until: req.query.until,
        refSince: req.query.refSince,
        refUntil: req.query.refUntil,
        bucket,
        now: Date.now(),
      });
      resolvedRanges.set(req, range);
      // One read per metric covering *both* windows: half the queries, and both
      // windows are guaranteed to have seen the same snapshot of the data.
      const span = spanningWindow(range, reference);

      const inputs: MoverInput[] = await mapPooled(
        scanned,
        BUCKET_READ_CONCURRENCY,
        async (metric) => {
          const rows = await store.metricBuckets(resolved.projectId, {
            metric: metric.id,
            bucket,
            since: span.since,
            until: span.until,
            scene: req.query.scene,
          });
          const split = partition(rows, range, reference);
          return {
            metric: metric.id,
            direction: metric.comparable?.direction ?? "neutral",
            minSample: metric.comparable?.minSample ?? 1,
            rollup: bucketMeasureFor(metric.id)?.rollup ?? "sum",
            current: split.current,
            reference: split.reference,
          };
        },
      );

      const rows: MoverRow[] = rankMovers(inputs, req.query.limit ?? 10);
      return rows;
    },
  );

  // =======================================================================
  // --- significance / scene health (#307) --------------------------------
  // =======================================================================

  /**
   * Is that difference real. One row: the effect, its interval, a p-value and
   * the test that produced them.
   */
  r.get(
    SIGNIFICANCE.endpoint!.path,
    {
      schema: {
        querystring: significanceQueryParams,
        response: { 200: rowsFor(SIGNIFICANCE), 400: badRequestResponse },
      },
    },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "query");
      if (!resolved) return reply;

      const unsupported = unsupportedParam(req);
      if (unsupported != null) {
        return reply.code(400).send({
          error:
            `${unsupported}: significance compares two time windows, not two segments. Use ` +
            "'since'/'until' for the window under test and 'refSince'/'refUntil' for the one it " +
            "is compared with " +
            "(the previous equal window by default). Splitting a metric by a dimension value is " +
            "not available yet, and answering a segment question with a window comparison would " +
            "compare the wrong two things.",
          metric: req.query.metric,
        });
      }

      const metric = resolveSeriesMetric(req.query.metric);
      if (isRejection(metric)) return reply.code(400).send(metric);

      const bucket: BucketGrain = req.query.bucket ?? "day";
      const { range, reference } = resolveMoversWindows({
        since: req.query.since,
        until: req.query.until,
        refSince: req.query.refSince,
        refUntil: req.query.refUntil,
        bucket,
        now: Date.now(),
      });
      resolvedRanges.set(req, range);
      // One read spanning both windows, split in TypeScript — the same trick
      // `movers` uses, and for the same two reasons: half the queries, and both
      // windows are guaranteed to have seen one snapshot of the data.
      const span = spanningWindow(range, reference);
      const read = (variant?: BucketVariant): Promise<MetricBucketRow[]> =>
        store.metricBuckets(resolved.projectId, {
          metric: metric.id,
          variant,
          bucket,
          since: span.since,
          until: span.until,
          scene: req.query.scene,
        });

      const rate = isDeclaredRate(metric);
      const [valueRows, denominatorRows] = await Promise.all([
        read(),
        rate ? read("denominator") : Promise.resolve(null),
      ]);
      const split = partition(valueRows, range, reference);
      const denominator =
        denominatorRows == null
          ? undefined
          : (() => {
              const parts = partition(denominatorRows, range, reference);
              return { current: parts.current, reference: parts.reference };
            })();

      const row: SignificanceRow = computeSignificance({
        metric: metric.id,
        scene: req.query.scene,
        counting: isCountingMeasure(metric.id),
        unit: unitOf(metric),
        current: split.current,
        reference: split.reference,
        ...(denominator ? { denominator } : {}),
      });
      return [row];
    },
  );

  /**
   * Which scene is in trouble, and why. One row per scene, least healthy first,
   * every factor carrying the metric id behind it.
   */
  r.get(
    SCENE_HEALTH.endpoint!.path,
    {
      schema: {
        querystring: sceneHealthQueryParams,
        response: { 200: rowsFor(SCENE_HEALTH), 400: badRequestResponse },
      },
    },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "query");
      if (!resolved) return reply;

      const bucket: BucketGrain = req.query.bucket ?? "day";
      const { range, baseline: baselineWindow } = resolveHealthWindows({
        since: req.query.since,
        until: req.query.until,
        windowDays: req.query.window,
        bucket,
        now: Date.now(),
      });
      resolvedRanges.set(req, range);

      // Which scenes. A named scene is scored on its own; otherwise the busiest
      // scenes over the window, bounded — the fan-out is linear in this.
      let scenes: string[];
      if (req.query.scene != null) {
        scenes = [req.query.scene];
      } else {
        const rows = await store.scenes(resolved.projectId, {
          since: range.since,
          until: range.until,
          limit: HEALTH_MAX_SCENES,
        });
        scenes = rows
          .map((row) => row.scene_id)
          .filter((id) => id.length > 0)
          .slice(0, req.query.limit ?? HEALTH_DEFAULT_SCENES);
        // A project whose events carry no scene id is still a project: score it
        // as a whole rather than answering with an empty list.
        if (scenes.length === 0) scenes = [""];
      }

      // One read per (factor, side, scene) over the scored window, plus one per
      // (factor, side) for the project baseline — shared by every scene, so the
      // cost is `factors x sides x (scenes + 1)` and not `x scenes x 2`.
      const plan: HealthRead[] = [];
      for (const factor of HEALTH_FACTORS) {
        const sides: readonly { side: "numerator" | "denominator"; variant?: BucketVariant }[] = [
          { side: "numerator", ...(factor.numerator ? { variant: factor.numerator } : {}) },
          ...(factor.denominator
            ? [{ side: "denominator" as const, variant: factor.denominator }]
            : []),
        ];
        for (const { side, variant } of sides) {
          plan.push({
            scene: "",
            factor: factor.id,
            side,
            metric: factor.metric,
            variant,
            window: baselineWindow,
            baseline: true,
          });
          for (const scene of scenes) {
            plan.push({
              scene,
              factor: factor.id,
              side,
              metric: factor.metric,
              variant,
              window: range,
              baseline: false,
            });
          }
        }
      }

      const results = await mapPooled(plan, BUCKET_READ_CONCURRENCY, (read) =>
        store.metricBuckets(resolved.projectId, {
          metric: read.metric,
          variant: read.variant,
          bucket,
          since: read.window.since,
          until: read.window.until,
          // The baseline deliberately spans every scene: a factor is normalised
          // against the project, not against the scene's own past.
          scene: read.baseline || read.scene.length === 0 ? undefined : read.scene,
        }),
      );
      const series = new Map<string, MetricBucketRow[]>();
      plan.forEach((read, index) => series.set(readKey(read), results[index] ?? []));

      const rows: SceneHealthRow[] = scenes.map((scene) => {
        const inputs: Record<string, HealthFactorInput> = {};
        for (const factor of HEALTH_FACTORS) {
          const at = (side: "numerator" | "denominator", baseline: boolean) =>
            series.get(`${baseline ? "" : scene}|${factor.id}|${side}|${baseline ? "b" : "c"}`) ??
            [];
          inputs[factor.id] = {
            current: {
              numerator: at("numerator", false),
              ...(factor.denominator ? { denominator: at("denominator", false) } : {}),
            },
            baseline: {
              numerator: at("numerator", true),
              ...(factor.denominator ? { denominator: at("denominator", true) } : {}),
            },
          };
        }
        return computeSceneHealth({
          scene,
          since: range.since,
          until: range.until,
          // Sessions started in the scene over the window: the `error_rate`
          // factor's denominator is exactly that series, so the number is read
          // off a scan already paid for.
          sampleSize: Math.round(seriesTotal(series.get(`${scene}|error_rate|denominator|c`))),
          inputs,
          weights: req.query.weights,
        });
      });
      return rankSceneHealth(rows);
    },
  );
};

/** The derived metrics this plugin serves, indexed by the path that serves them. */
const METRIC_BY_PATH = new Map<string, MetricDefinition>([
  [BASELINE.endpoint!.path, BASELINE],
  [MOVERS.endpoint!.path, MOVERS],
  // --- significance / scene health (#307) ---
  [SIGNIFICANCE.endpoint!.path, SIGNIFICANCE],
  [SCENE_HEALTH.endpoint!.path, SCENE_HEALTH],
]);
