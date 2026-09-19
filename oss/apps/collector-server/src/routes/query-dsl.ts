/**
 * **The query DSL endpoint** (ADR 0051 §3, design sketch §C.3).
 *
 * `POST /api/v1/query` with the JSON document, and `GET /api/v1/query?q=<url-encoded JSON>`
 * for the GET-only clients (the collector client in `@uptimizr/agent-core`, a
 * simple MCP host, `curl`). Both are reads and both need the ordinary `query`
 * capability — the DSL reaches exactly the aggregations the canned endpoints
 * already serve, so it grants nothing new.
 *
 * ## Why this is a separate plugin
 *
 * `routes/query.ts` is seventy hand-written routes, one per metric. This is one
 * route that can run any of them. It shares their machinery rather than
 * duplicating it — the same region/`cellSize` resolution helpers, the same
 * summariser, the same auth and the same audit hooks — but it has no business
 * being appended to that file.
 *
 * ## The request's journey
 *
 * 1. **Shape** — `queryV1Schema` (`@uptimizr/schema`). Closed grammar, bounded
 *    values, unknown keys rejected. No raw SQL can be expressed.
 * 2. **Vocabulary** — `validateQuery` (`@uptimizr/metrics`). Does the metric
 *    exist, is it an aggregation, does it accept these dimensions and filters,
 *    is the limit within its cap. Every objection is collected, so one `400`
 *    tells the caller everything that is wrong, with the accepted values named.
 * 3. **Resolution** — a `region` given as a registered region id becomes bounds,
 *    and a spatial metric with no `cellSize` gets the one derived from the
 *    scene's registered extent (ADR 0040 §1), exactly as the canned routes do.
 * 4. **Compilation** — `store.runMetric` renders the metric's own builder for
 *    the store's dialect and runs it. No second SQL path exists.
 * 5. **Shaping** — `format` (`full` | `table` | `summary`), applied here with
 *    the same pure `@uptimizr/db` functions the canned routes' `preSerialization`
 *    hook uses. The DSL defaults to `table`: it is an agent-facing surface, and
 *    rows without the window, the sample size and the truncation flag are
 *    exactly what the envelope exists to prevent.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { queryV1Schema, type QueryV1 } from "@uptimizr/schema";
import {
  ORDER_AFTER_CAP_CAVEAT,
  applyOrder,
  channelRows,
  compareRows,
  comparisonKeys,
  explainQuery,
  queryEnvelopeSchema,
  reordersCappedResult,
  summarizeComparison,
  summarizeRows,
  tableResult,
  toBuilderOptions,
  type ComparisonContext,
  type MetricQueryOptions,
  type PlanContext,
  type QueryResolution,
  type SampleSize,
  type SummaryContext,
  type WorldAabb,
} from "@uptimizr/db";
import {
  dimensionColumn,
  validateQuery,
  type DimensionId,
  type MetricDefinition,
  type MetricId,
  type QueryTier,
} from "@uptimizr/metrics";
import type { CollectorStore } from "../store.js";
import { requireCapability } from "../auth.js";
import { computeSpatialCellSize, isRegionError, resolveRegionFilter } from "./query.js";

interface Options {
  store: CollectorStore;
}

/**
 * `GET /api/v1/query?q=…`: the whole document, URL-encoded, in one parameter.
 *
 * Bounded at 8 KiB so a malformed or hostile `q` is rejected before it is
 * parsed — well above any real query (the largest is a twenty-step funnel) and
 * well below what a proxy will carry in a URL.
 */
const getQueryParams = z.object({
  q: z.string().min(1).max(8192),
});

/** `{ error, issues? }` — the one shape every rejection uses. */
const badRequestResponse = z.object({
  error: z.string(),
  issues: z
    .array(
      z.object({
        code: z.string(),
        path: z.string(),
        message: z.string(),
        accepted: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

/**
 * The 200 body: the same three envelopes every registry-served endpoint can
 * answer with, over a row shape that is only known at request time (it is the
 * metric's). The row is therefore a loose object — the registry's own `row`
 * schema is what *describes* the columns, and it reaches the caller through
 * `GET /api/v1/openapi.json` and the metric's canned endpoint rather than by
 * being restated here.
 */
const looseRow = z.looseObject({});
const queryResponse = queryEnvelopeSchema(z.array(looseRow), looseRow);

/**
 * Parse the `q` parameter of the GET form. A JSON syntax error is the caller's,
 * so it is a `400` with the parser's own message rather than a 500.
 */
function parseGetQuery(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, error: `q is not valid JSON: ${err instanceof Error ? err.message : ""}` };
  }
}

/**
 * Everything the summariser needs about the request that produced the rows.
 * The DSL knows all of it first-hand: the range is required, the filters are
 * already a typed object, and the effective row cap is the query's `limit` or
 * the metric's registry cap.
 */
function summaryContextFor(
  metric: MetricDefinition,
  query: QueryV1,
  cellSize: number | undefined,
  caveats: readonly string[] = [],
): SummaryContext {
  return {
    range: { since: query.range.since, until: query.range.until },
    filters: { ...(query.filters ?? {}) },
    limit: query.limit ?? metric.limits.maxRows,
    cellSize,
    // Given the query, every ranked row carries the *query* that narrows to it
    // rather than a bag of filter names (#304) — see `drillQueryFor`.
    query: { ...query },
    ...(caveats.length > 0 ? { caveats } : {}),
  };
}

/** The dimensions a query actually groups by: its own, or the metric's grain. */
function effectiveDimensions(metric: MetricDefinition, query: QueryV1): readonly DimensionId[] {
  return (query.dimensions as readonly DimensionId[] | undefined) ?? metric.grainDimensions;
}

/** The same query with its range and segment replaced by the comparison's. */
function comparisonQuery(query: QueryV1): QueryV1 {
  if (query.compare == null) return query;
  if ("range" in query.compare) return { ...query, range: query.compare.range };
  return { ...query, segment: query.compare.segment };
}

/**
 * Per-event-type counts over the query's window, used for the two things
 * `explain` can only answer with them: which capture channels are silent, and
 * how many events of this metric's own channels exist at all.
 *
 * Run through `event_counts` — the metric whose whole job this is — so it takes
 * the same compiled path, the same coercion and the same parity coverage as
 * every other read. A failure here must never fail the explain: a plan without
 * channel warnings is still worth more than a 500.
 */
async function channelCounts(
  store: CollectorStore,
  projectId: string,
  query: QueryV1,
): Promise<Record<string, number> | undefined> {
  try {
    const rows = await store.runMetric(projectId, "event_counts" as MetricId, {
      since: query.range.since,
      until: query.range.until,
      ...(query.filters?.scene != null ? { scene: query.filters.scene } : {}),
    });
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const type = row.event_type;
      const count = row.count;
      if (typeof type === "string" && typeof count === "number") counts[type] = count;
    }
    return counts;
  } catch {
    return undefined;
  }
}

/**
 * Whether the project has anything a spatial hotspot could be *named* after.
 * Only asked for a binned or voxelised metric, and never allowed to fail the
 * request.
 */
async function spatialLabels(
  store: CollectorStore,
  projectId: string,
  metric: MetricDefinition,
  query: QueryV1,
): Promise<{ proxy: boolean; regions: number } | undefined> {
  if (metric.grain !== "bin" && metric.grain !== "voxel") return undefined;
  try {
    const scene = query.filters?.scene;
    const proxies = await store.listSceneRepresentations(projectId);
    const regions = await store.listSceneRegions(projectId);
    const matches = (id: string | undefined): boolean => scene == null || id === scene;
    return {
      proxy: proxies.some((representation) => matches(representation.sceneId)),
      regions: regions.filter((region) => matches(region.sceneId)).length,
    };
  } catch {
    return undefined;
  }
}

/** Build the `explain: true` plan for a query, without running it. */
async function explainOnly(
  store: CollectorStore,
  projectId: string,
  metric: MetricDefinition,
  query: QueryV1,
  tier: QueryTier,
  options: MetricQueryOptions,
): Promise<unknown> {
  const described = store.describeMetric(projectId, metric.id as MetricId, options);
  const counts = await channelCounts(store, projectId, query);
  const spatial = await spatialLabels(store, projectId, metric, query);
  // `explain` deliberately does not run the query, so the sample it reports is
  // the *window's* — how many events of this metric's own capture channels exist
  // to answer from — rather than the result's. That is the number the
  // below-minimum warning should weigh anyway, and it costs the one
  // `event_counts` pass already made rather than a second run of the query.
  const sampleSize: SampleSize = { sessions: null, events: channelRows(metric, counts) };
  const context: PlanContext = {
    tier,
    dialect: described?.dialect ?? "none",
    ...(counts != null ? { channelCounts: counts } : {}),
    sampleSize,
    ...(spatial != null ? { spatial } : {}),
    extra:
      described == null
        ? ["This store compiles no SQL, so the plan carries the warnings only."]
        : [],
  };
  const spec = described?.spec ?? { query: "", query_params: {} };
  return explainQuery(metric, spec, context);
}

/** Run a `compare` query: the same spec twice, joined in TypeScript. */
async function runComparison(
  store: CollectorStore,
  projectId: string,
  metric: MetricDefinition,
  query: QueryV1,
  tier: QueryTier,
  resolved: QueryResolution,
  options: MetricQueryOptions,
): Promise<unknown> {
  const other = comparisonQuery(query);
  const previousOptions = toBuilderOptions(other, resolved, tier);
  const [current, previous] = await Promise.all([
    store.runMetric(projectId, metric.id as MetricId, options),
    store.runMetric(projectId, metric.id as MetricId, previousOptions),
  ]);

  const columns = effectiveDimensions(metric, query).map((dimension) =>
    dimensionColumn(metric, dimension),
  );
  const context: ComparisonContext = {
    basis: query.compare != null && "range" in query.compare ? "range" : "segment",
    keys: comparisonKeys(metric, columns),
    currentRange: { since: query.range.since, until: query.range.until },
    previousRange: { since: other.range.since, until: other.range.until },
    currentSegment: query.segment,
    previousSegment: other.segment,
    limit: query.limit ?? metric.limits.maxRows,
  };
  const comparison = compareRows(metric, current, previous, context);
  if (comparison == null) return current;
  if (query.format === "summary") {
    return summarizeComparison(metric, comparison, { maxRows: metric.limits.maxSummaryRows });
  }
  // `full` gives the joined rows on their own; `table` keeps the envelope that
  // says which windows they came from and whether either was truncated.
  return query.format === "full" ? comparison.rows : comparison;
}

/**
 * Resolve the two values a query cannot carry on its own: a registered region
 * id's bounds, and the voxel `cellSize` a spatial metric should use when the
 * caller did not pin one. Returns the resolution, or an error string for a
 * `400` (an unknown region id must never be answered as "no hits here").
 */
async function resolveQuery(
  store: CollectorStore,
  projectId: string,
  query: QueryV1,
): Promise<QueryResolution | { error: string }> {
  const filters = query.filters ?? {};
  const resolution: QueryResolution = {};

  if (filters.region != null) {
    const filter =
      typeof filters.region === "string"
        ? ({ kind: "id", id: filters.region } as const)
        : ({ kind: "box", bounds: filters.region as unknown as WorldAabb } as const);
    const bounds = await resolveRegionFilter(store, projectId, filters.scene, filter);
    if (isRegionError(bounds)) return bounds;
    resolution.region = bounds;
  }

  // Only ask for a derived cell size when the metric can take one and the
  // caller left it open; `computeSpatialCellSize` returns the pinned value
  // otherwise, and `undefined` when nothing is known (the builder's own default).
  const cellSize = await computeSpatialCellSize(store, projectId, {
    cellSize: filters.cellSize,
    scene: filters.scene,
    region: resolution.region,
  });
  if (cellSize != null) resolution.cellSize = cellSize;

  return resolution;
}

/**
 * Run one validated query and shape the response. Shared by both transports so
 * `POST` and `GET` cannot drift apart: the body and the decoded `q` are the same
 * document, and everything after parsing is identical.
 */
async function runQuery(
  store: CollectorStore,
  request: FastifyRequest,
  reply: FastifyReply,
  input: unknown,
): Promise<unknown> {
  const parsed = queryV1Schema.safeParse(input);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "the query is not a valid queryV1 document",
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const query = parsed.data;

  // What the audit log records for this request: the querystring is empty on the
  // POST form, so the query itself is the only honest description of it.
  request.auditParams = {
    metric: query.metric,
    since: query.range.since,
    until: query.range.until,
    format: query.format,
    ...(query.limit != null ? { limit: query.limit } : {}),
    // Stage 2 fields, so the log says what was actually asked for: an `explain`
    // ran no aggregation and a `compare` ran two (#304).
    ...(query.explain ? { explain: true } : {}),
    ...(query.compare != null ? { compare: "range" in query.compare ? "range" : "segment" } : {}),
    ...(query.dimensions != null ? { dimensions: query.dimensions.join(",") } : {}),
    ...(query.filters ?? {}),
  };

  const { issues, metric, tier } = validateQuery(query);
  if (issues.length > 0 || !metric || tier == null) {
    return reply.code(400).send({
      error: `the query cannot be answered: ${issues[0]?.message ?? "unknown metric"}`,
      issues: issues.map((issue) => ({ ...issue })),
    });
  }

  const projectId = request.resolvedKey?.projectId;
  if (projectId == null) return reply.code(401).send({ error: "missing or unknown API key" });

  const resolved = await resolveQuery(store, projectId, query);
  if ("error" in resolved) return reply.code(400).send({ error: resolved.error });

  const options: MetricQueryOptions = toBuilderOptions(query, resolved, tier);

  // `explain` answers with the plan instead of the rows, so it must come before
  // anything that runs one.
  if (query.explain) {
    return explainOnly(store, projectId, metric, query, tier, options);
  }
  if (query.compare != null) {
    return runComparison(store, projectId, metric, query, tier, resolved, options);
  }

  const raw = await store.runMetric(projectId, metric.id as MetricId, options);
  // The generic tier put `order` in its own `ORDER BY`; a delegated metric's
  // builder did not, so the rows are re-sorted here — honestly, with a caveat
  // when the builder's own cap had already chosen which rows exist.
  const reorder = tier === "delegated" ? query.order : undefined;
  const rows = reorder == null ? raw : applyOrder(raw, reorder);
  const caveats =
    reorder != null && reordersCappedResult(rows, query.limit ?? metric.limits.maxRows)
      ? [ORDER_AFTER_CAP_CAVEAT]
      : [];

  if (query.format === "full") return rows;
  const context = summaryContextFor(metric, query, resolved.cellSize, caveats);
  const shaped =
    query.format === "table"
      ? tableResult(metric, rows, context)
      : summarizeRows(metric, rows, context);
  // `null` only comes back for a metric the registry does not know, which
  // `validateQuery` already excluded — fall back to the rows rather than fail.
  return shaped ?? rows;
}

/**
 * The query DSL routes. Registered as its own plugin in `app.ts`, after
 * `queryRoutes` (whose `format` hook it deliberately does not rely on — this
 * route shapes its own response, because it knows its filters and window
 * first-hand rather than having to read them back off a querystring).
 */
export const queryDslRoutes: FastifyPluginAsync<Options> = async (app, { store }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/v1/query",
    {
      schema: {
        body: z.unknown(),
        response: { 200: queryResponse, 400: badRequestResponse },
      },
    },
    async (req, reply) => {
      // Validated by `queryV1Schema` inside `runQuery` rather than by the route
      // schema, so the POST and GET forms produce byte-identical error bodies.
      if (!(await requireCapability(req, reply, store, "query"))) return reply;
      return runQuery(store, req, reply, req.body);
    },
  );

  r.get(
    "/api/v1/query",
    {
      schema: {
        querystring: getQueryParams,
        response: { 200: queryResponse, 400: badRequestResponse },
      },
    },
    async (req, reply) => {
      if (!(await requireCapability(req, reply, store, "query"))) return reply;
      const decoded = parseGetQuery(req.query.q);
      if (!decoded.ok) return reply.code(400).send({ error: decoded.error });
      return runQuery(store, req, reply, decoded.value);
    },
  );
};
