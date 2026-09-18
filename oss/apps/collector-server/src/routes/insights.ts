/**
 * **Insight primitives** — `GET /api/v1/insights/*` (ADR 0051 §4, sketch §D).
 *
 * Two registry metrics that answer the questions an agent otherwise re-derives
 * from raw rows on every turn:
 *
 * - `insight_baseline` — what is normal for one metric in one scene;
 * - `insight_movers` — what changed, ranked by how unusual the change is;
 * - `insight_anomalies` — which buckets of one metric do not belong, and what
 *   inside the metric accounts for them (#306).
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
  MAX_ANOMALY_SENSITIVITY,
  MIN_ANOMALY_SENSITIVITY,
  MOVERS_DEFAULT_METRICS,
  MOVERS_MAX_METRICS,
  attributeContributor,
  bucketMeasureFor,
  computeBaseline,
  contributorDimensionFor,
  contributorWindows,
  detectAnomalies,
  inContributorWindow,
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
  type AnomalyRow,
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

// --- anomalies (#306) ------------------------------------------------------
/**
 * `GET /api/v1/insights/anomalies` parameters.
 *
 * The same subject-plus-window shape as `baseline` — an anomaly is an anomaly
 * *of* one metric — with one extra dial. `sensitivity` is bounded by the schema
 * rather than clamped silently, so a caller who asks for `0` (which would report
 * every bucket) is told the range instead of being handed noise.
 */
const anomaliesQueryParams = z.object({
  metric: z.string().min(1).max(64),
  scene: sceneFilter,
  window: z.coerce.number().int().positive().max(365).optional(),
  bucket: bucketFilter,
  sensitivity: z.coerce
    .number()
    .min(MIN_ANOMALY_SENSITIVITY)
    .max(MAX_ANOMALY_SENSITIVITY)
    .optional(),
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
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
// --- anomalies (#306) ---
const ANOMALIES = metricFor("insight_anomalies");

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

  // --- anomalies (#306) ----------------------------------------------------
  /**
   * When one metric stopped behaving. One row per anomalous bucket, oldest
   * first, each carrying what was expected, how far out it was, and — where the
   * metric declares a split dimension — which value inside it accounts for the
   * excess.
   *
   * Cost is `1 + min(anomalous windows, ANOMALY_MAX_CONTRIBUTOR_SCANS)` grouped
   * scans: one to build the series, and at most three to attribute it. The cap
   * is the reason a pathological series (every bucket anomalous) cannot turn one
   * request into a hundred scans.
   */
  r.get(
    ANOMALIES.endpoint!.path,
    {
      schema: {
        querystring: anomaliesQueryParams,
        response: { 200: rowsFor(ANOMALIES), 400: badRequestResponse },
      },
    },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "query");
      if (!resolved) return reply;

      const metric = resolveSeriesMetric(req.query.metric);
      if (isRejection(metric)) return reply.code(400).send(metric);

      const bucket: BucketGrain = req.query.bucket ?? "day";
      // Same window resolution as `baseline`: the two answer questions about the
      // same series, and a caller who reads one and then the other must not have
      // to reason about two different notions of "the last 28 days".
      const range = resolveBaselineWindow({
        since: req.query.since,
        until: req.query.until,
        windowDays: req.query.window,
        bucket,
        now: Date.now(),
      });
      resolvedRanges.set(req, range);

      const series = await store.metricBuckets(resolved.projectId, {
        metric: metric.id,
        bucket,
        since: range.since,
        until: range.until,
        scene: req.query.scene,
      });
      const rows: AnomalyRow[] = detectAnomalies(metric.id, req.query.scene, series, {
        bucket,
        sensitivity: req.query.sensitivity,
      });

      const dimension = contributorDimensionFor(metric.id, { scene: req.query.scene });
      if (dimension == null || rows.length === 0) return rows;

      // One extra grouped scan per anomalous window, capped. Each scan is
      // clamped to the analysed range, so attribution never reads outside the
      // window the caller asked about and each split value's "before" is the
      // same history the detection itself used.
      const windows = contributorWindows(rows, { bucket, seriesUntil: range.until });
      const splits = await mapPooled(windows, BUCKET_READ_CONCURRENCY, (window) =>
        store.metricBuckets(resolved.projectId, {
          metric: metric.id,
          bucket,
          since: Math.max(window.since, range.since),
          until: Math.min(window.until, range.until),
          scene: req.query.scene,
          groupBy: dimension,
        }),
      );
      for (const [index, window] of windows.entries()) {
        const splitRows = splits[index] ?? [];
        for (const row of rows) {
          if (row.contributor != null || !inContributorWindow(row, window)) continue;
          row.contributor = attributeContributor(row, dimension, splitRows);
        }
      }
      return rows;
    },
  );
};

/** The derived metrics, indexed by the path that serves them. */
const METRIC_BY_PATH = new Map<string, MetricDefinition>([
  [BASELINE.endpoint!.path, BASELINE],
  [MOVERS.endpoint!.path, MOVERS],
  // --- anomalies (#306) ---
  [ANOMALIES.endpoint!.path, ANOMALIES],
]);
