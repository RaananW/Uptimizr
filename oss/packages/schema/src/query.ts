import { z } from "zod";
import { aabbSchema } from "./sceneProxy.js";
import { epochMsSchema, sceneIdSchema } from "./primitives.js";
import { regionIdSchema } from "./sceneRegion.js";
import { inputSourceSchema } from "./events/inputSource.js";
import { funnelStepSchema, funnelStepsSchema } from "./funnel.js";

/**
 * **Analytics query DSL v1** (ADR 0051 §3, design sketch §C.1).
 *
 * One closed, validated request over the metric vocabulary, so an agent picks a
 * metric, bounds it, narrows it and caps it in a single call rather than
 * guessing which of the seventy canned endpoints carries which flag.
 *
 * Like `funnel.ts` this is a **config / contract** shape, not an event: it is
 * not part of the event union and never reaches the store as data. It lives here
 * because both ends of the wire need the same definition — the collector
 * validates with it, `@uptimizr/agent-core` advertises it as a tool's input
 * schema, and an SDK consumer can build a request against it.
 *
 * ## The grammar is closed, and only structurally validated here
 *
 * There is **no raw SQL and no free-form expression** anywhere below: `metric`
 * and `dimensions` are identifiers, every filter is a typed value, and the
 * output is bounded by `limit` (and, above that, by the metric's own registry
 * cap). Unknown keys are rejected (`.strict()`), so a typo is an error rather
 * than a silently-ignored filter.
 *
 * What this file deliberately does **not** do is decide whether `metric` names a
 * real metric, whether that metric accepts a given `dimension` or `filter`, or
 * whether `limit` is within that metric's cap. Those are questions about the
 * *vocabulary*, and the vocabulary lives in `@uptimizr/metrics` — a package this
 * one cannot depend on (it depends on this one). So `metric` and the dimension
 * ids are validated here as **bounded identifiers**, and
 * `validateQuery()` in `@uptimizr/metrics` answers the registry questions and
 * returns typed, registry-derived errors. The collector runs both, in that
 * order.
 *
 * ## What v1 executes
 *
 * v1 is the **delegated** compilation tier (design sketch §C.2): a query maps
 * onto the metric's existing aggregation builder, so every metric is reachable
 * at exactly the power its canned endpoint already has. `compare`, `segment`,
 * `order`, `explain`, `filters.event` and `filters.device` are part of the
 * published grammar and are parsed here, but the collector answers `400 … not
 * supported yet` for them until the generic group-by / compare / explain tier
 * lands (#304). They are declared now so the grammar is published once and a
 * client written against it does not have to be rewritten.
 */

/** Maximum rows any single query may ask for, before the metric's own cap. */
export const QUERY_MAX_LIMIT = 1000;

/** Maximum group-by dimensions a query may name (design sketch §C.1). */
export const QUERY_MAX_DIMENSIONS = 3;

/**
 * A metric id, validated **structurally**: lower `snake_case`, 1–64 characters.
 * Membership in the registry is checked by `validateQuery()` in
 * `@uptimizr/metrics` — see the module doc for why the two are split.
 */
export const queryMetricIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "metric must be a lower_snake_case registry metric id");

/**
 * A group-by dimension id, validated structurally: a name that starts
 * lower-case, with an optional dotted namespace (`mesh`, `source`,
 * `cameraMode`, `device.os`). Membership in the metric's declared dimensions is
 * checked by `validateQuery()`.
 *
 * The first segment admits `camelCase` because one registry dimension is spelled
 * that way — `cameraMode`, whose value is a session's `scene.cameraType`. v1
 * could not notice: `dimensions` had to be the metric's own grain there, and no
 * metric is *keyed* by the camera mode. The generic group-by tier and `segment`
 * (#304) both name dimensions that are otherwise only filters, so the id grammar
 * has to cover the whole `DimensionId` union rather than the part of it that
 * happened to be reachable.
 */
export const queryDimensionIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-zA-Z_]*(\.[a-zA-Z][a-zA-Z_]*)?$/, "dimension must be a registry dimension id");

/**
 * The world-space region a query is scoped to: either an **ad-hoc box**
 * `[minX,minY,minZ,maxX,maxY,maxZ]` (ADR 0040 §4) or the **id of a registered
 * scene region** (ADR 0051 §2), which the collector resolves to that region's
 * stored bounds before the aggregation layer ever sees it. A region id requires
 * the query to also name the `scene` the region belongs to.
 */
export const queryRegionSchema = z.union([regionIdSchema, aabbSchema]);
export type QueryRegion = z.infer<typeof queryRegionSchema>;

/**
 * Device-attribute filters (design sketch §C.1). Parsed, but **not executed by
 * v1**: no aggregation builder takes a device predicate, so a query carrying one
 * is a `400` until the generic group-by tier lands (#304).
 */
export const queryDeviceFilterSchema = z
  .object({
    os: z.string().min(1).max(64).optional(),
    browser: z.string().min(1).max(64).optional(),
    gpuTier: z.string().min(1).max(64).optional(),
  })
  .strict();
export type QueryDeviceFilter = z.infer<typeof queryDeviceFilterSchema>;

/**
 * The filter vocabulary.
 *
 * Every key is one of the registry's `FilterId`s — the same names the canned
 * endpoints' querystrings use, so a filter means the same thing wherever it
 * appears — with three deliberate differences:
 *
 * - `since` / `until` are not here: the time window is the required `range`.
 * - `format` is not here: it selects the response envelope rather than narrowing
 *   anything, so it is a top-level field.
 * - the JSON-encoded parameters of the querystring (`steps`, `variant`,
 *   `conversion`, `bands`, `region`) are **real JSON** here. The DSL is already a
 *   JSON document; re-encoding a funnel predicate as a string inside it would be
 *   a second, weaker parser for no gain.
 *
 * Which keys a given metric accepts is the registry's answer, not this schema's:
 * `validateQuery()` rejects a filter the metric does not declare, naming the ones
 * it does. Everything here is therefore optional.
 *
 * `@uptimizr/metrics`' `src/__tests__/query.test.ts` asserts these keys and the
 * registry's `FilterId` union stay in step, so a new filter cannot reach a
 * canned endpoint without reaching the DSL.
 */
export const queryFiltersSchema = z
  .object({
    // --- the narrowing filters of design sketch §C.1 ---
    scene: sceneIdSchema.optional(),
    session: z.string().min(1).max(128).optional(),
    source: inputSourceSchema.optional(),
    cameraMode: z.enum(["viewer", "first-person"]).optional(),
    mesh: z.string().min(1).max(256).optional(),
    region: queryRegionSchema.optional(),
    /** ADR 0038 event predicate. Parsed, not executed by v1 — see the module doc. */
    event: funnelStepSchema.optional(),
    /** Device attributes. Parsed, not executed by v1 — see the module doc. */
    device: queryDeviceFilterSchema.optional(),

    // --- the builder knobs the canned endpoints expose, so a DSL query is
    //     never weaker than the endpoint it replaces ---
    bins: z.number().int().positive().max(500).optional(),
    cellSize: z.number().positive().max(1000).optional(),
    interval: z.number().int().positive().max(31_536_000).optional(),
    type: z.string().min(1).max(64).optional(),
    bucket: z.number().int().positive().max(240).optional(),
    bucketMs: z.number().int().positive().max(60_000).optional(),
    bucketSize: z.number().positive().max(1000).optional(),
    minRepeats: z.number().int().min(2).max(100).optional(),
    windowMs: z.number().int().positive().max(86_400_000).optional(),
    fpsThreshold: z.number().positive().max(240).optional(),
    stallMs: z.number().nonnegative().max(60_000).optional(),
    moveThreshold: z.number().nonnegative().max(1000).optional(),
    rapidTurn: z.number().nonnegative().max(Math.PI).optional(),
    centerX: z.number().optional(),
    centerY: z.number().optional(),
    centerZ: z.number().optional(),
    severity: z.string().min(1).max(64).optional(),
    category: z.string().min(1).max(64).optional(),
    errorKind: z.string().min(1).max(64).optional(),
    groupByOrigin: z.boolean().optional(),
    originVoxel: z
      .string()
      .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
      .optional(),
    steps: funnelStepsSchema.optional(),
    bands: z.array(z.number().nonnegative()).min(1).max(10).optional(),
    variant: funnelStepSchema.optional(),
    conversion: funnelStepSchema.optional(),
  })
  .strict();
export type QueryFilters = z.infer<typeof queryFiltersSchema>;

/**
 * The time window. **Required**, and both ends are required: an unbounded
 * analytics query is the one thing a bounded DSL must not allow, and "since the
 * beginning of time" is never what an agent actually means. `since` is
 * inclusive, `until` exclusive.
 */
export const queryRangeSchema = z
  .object({ since: epochMsSchema, until: epochMsSchema })
  .strict()
  .refine((range) => range.until > range.since, {
    message: "range.until must be greater than range.since",
  });
export type QueryRange = z.infer<typeof queryRangeSchema>;

/** A named slice: dimension id → the value to hold fixed. */
export const querySegmentSchema = z.record(queryDimensionIdSchema, z.string().min(1).max(256));
export type QuerySegment = z.infer<typeof querySegmentSchema>;

/**
 * What to compare the result against: another time range, or another segment.
 * Parsed, not executed by v1 (#304).
 */
export const queryCompareSchema = z.union([
  z.object({ range: queryRangeSchema }).strict(),
  z.object({ segment: querySegmentSchema }).strict(),
]);
export type QueryCompare = z.infer<typeof queryCompareSchema>;

/** Result ordering. Parsed, not executed by v1 — every builder has its own order (#304). */
export const queryOrderSchema = z
  .object({
    by: z.string().min(1).max(64),
    dir: z.enum(["asc", "desc"]),
  })
  .strict();
export type QueryOrder = z.infer<typeof queryOrderSchema>;

/**
 * One analytics query (ADR 0051 §3).
 *
 * ```json
 * {
 *   "v": 1,
 *   "metric": "mesh_sources",
 *   "dimensions": ["mesh", "source"],
 *   "filters": { "scene": "lobby", "cameraMode": "first-person" },
 *   "range": { "since": 1757000000000, "until": 1757600000000 },
 *   "limit": 20,
 *   "format": "summary"
 * }
 * ```
 */
export const queryV1Schema = z
  .object({
    /** Grammar version. Pinned to `1` so a future grammar is a new literal, not a silent change. */
    v: z.literal(1),
    /** The registry metric to compute. */
    metric: queryMetricIdSchema,
    /**
     * Group-by dimensions. In v1 these must equal the metric's **native grain**
     * (the dimension columns its rows already carry) or be omitted; a different
     * subset is a `400` naming the dimensions the metric supports. Arbitrary
     * subsets arrive with the generic group-by tier (#304).
     */
    dimensions: z.array(queryDimensionIdSchema).max(QUERY_MAX_DIMENSIONS).optional(),
    filters: queryFiltersSchema.optional(),
    range: queryRangeSchema,
    /** A named slice to hold fixed. Parsed, not executed by v1 (#304). */
    segment: querySegmentSchema.optional(),
    /** A second range or segment to compare against. Parsed, not executed by v1 (#304). */
    compare: queryCompareSchema.optional(),
    /** Result ordering. Parsed, not executed by v1 (#304). */
    order: queryOrderSchema.optional(),
    /** Row cap. Bounded here, and again by the metric's registry `limits.maxRows`. */
    limit: z.number().int().positive().max(QUERY_MAX_LIMIT).optional(),
    /**
     * Result envelope (ADR 0051 §2). Unlike the canned endpoints — whose default
     * is `full`, because the dashboard has always read bare rows from them — the
     * DSL defaults to `table`: it is a new, agent-facing surface, and an agent
     * reading rows without knowing the window, the sample size or whether the
     * result was truncated is exactly the failure mode the envelope exists to
     * prevent.
     */
    format: z.enum(["full", "table", "summary"]).default("table"),
    /** Return the compiled plan instead of running it. Parsed, not executed by v1 (#304). */
    explain: z.boolean().default(false),
  })
  .strict();

/** A parsed query, with `format` / `explain` defaulted. */
export type QueryV1 = z.infer<typeof queryV1Schema>;

/** A query exactly as a client writes it, before defaults are applied. */
export type QueryV1Input = z.input<typeof queryV1Schema>;
