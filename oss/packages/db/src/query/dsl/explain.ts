/**
 * **`explain`: can I trust this?** (ADR 0051 §3, design sketch §C.2).
 *
 * The second thing an agent cannot do today. A result that came back empty
 * because the capture channel is switched off looks exactly like a result that
 * came back empty because nothing happened — and a model will report the second
 * either way. `explain: true` answers the request with the **plan** instead of
 * the rows: which tier would run, the SQL that tier renders for this store's
 * dialect, the parameters it binds, how much data is behind the window, and
 * every reason the answer might not mean what it looks like.
 *
 * ## Why the SQL can be shown at all
 *
 * Because it contains nothing to redact. The DSL's whole design is that no
 * caller-supplied value ever reaches the SQL text: a scene id, a mesh name, an
 * event predicate and a row cap are all bound parameters, and
 * `src/__tests__/queryDsl.test.ts` proves it by pushing a hostile string through
 * every filter and asserting it appears only in `query_params`. So the rendered
 * plan is the *shape* of the query with placeholders where the values are, and
 * {@link explainSpec} lists the parameters by **name and logical type only** —
 * never their values, which may be a session id or a mesh name the caller is not
 * entitled to see echoed into a shared transcript.
 *
 * That is also what makes `explain` worth having: a reader can check for
 * themselves that the filter they asked for is in the `WHERE`, and that nothing
 * else is.
 *
 * ## `rowsScanned`
 *
 * No supported engine reports rows scanned without either a second pass or a
 * dialect-specific `EXPLAIN ANALYZE`, and paying for either on a read endpoint
 * would be a poor trade. What the collector *can* answer cheaply is the honest
 * version of the same question — how many events of the metric's own capture
 * channels exist in the window — from the `event_counts` pass it already runs to
 * detect a disabled channel. `null` where the metric declares no channels (a
 * derived rollup).
 */

import type { EventType } from "@uptimizr/schema";
import type { MetricDefinition, MetricId, QueryTier } from "@uptimizr/metrics";
import type { QuerySpec } from "../types.js";
import type { SampleSize } from "../summary/types.js";

/** The logical type of a bound parameter, as the plan reports it. */
export type ExplainParamType = "string" | "number" | "timestamp" | "boolean" | "json";

/** One bound parameter, named and typed — never valued. */
export interface ExplainParam {
  name: string;
  type: ExplainParamType;
}

/** The plan `explain: true` answers with. */
export interface QueryPlan {
  metric: MetricId;
  /** Which compiler would run it (design sketch §C.2). */
  tier: QueryTier;
  /** The store's engine, so the SQL below is readable in context. */
  dialect: string;
  /** The rendered SQL, parameters left as placeholders. */
  sql: string;
  /** Every parameter the SQL binds, by name and logical type. */
  params: readonly ExplainParam[];
  /**
   * Events of the metric's own capture channels in the window — the cheap,
   * honest stand-in for "rows scanned". `null` when the metric declares no
   * channels, or when the collector could not count them.
   */
  rowsScanned: number | null;
  /** How much data is behind the window, on the metric's own terms. */
  sampleSize: SampleSize;
  /** Every reason the answer might not mean what it looks like. */
  warnings: readonly string[];
}

/** Everything the collector knows that the plan should say. */
export interface PlanContext {
  tier: QueryTier;
  /** The store's dialect name (`duckdb`, `clickhouse`, …). */
  dialect: string;
  /** Per-event-type counts over the query's range, for the channel warnings. */
  channelCounts?: Readonly<Record<string, number>>;
  /** How much data is behind the result. */
  sampleSize?: SampleSize;
  /** The row cap in force, and the rows the query produced, for truncation. */
  limit?: number;
  rows?: number;
  /** Whether the project has the scene geometry a spatial label would need. */
  spatial?: { proxy: boolean; regions: number };
  /** Extra warnings the route knows and this module cannot. */
  extra?: readonly string[];
}

/** Collapse the rendered SQL to something a human can read in a transcript. */
function tidy(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => line.replace(/^ {6}/, ""))
    .join("\n")
    .trim();
}

/** The logical type of a bound value, without ever reporting the value. */
function typeOf(value: unknown): ExplainParamType {
  if (value instanceof Date) return "timestamp";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") {
    // Every dialect binds a timestamp as either a `Date` or an ISO-8601 /
    // naive-UTC string; `2024-06-16T10:00:00.000` is not a value anyone supplied
    // as text, so reporting it as a timestamp is more useful than "string".
    return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value) ? "timestamp" : "string";
  }
  return "json";
}

/** The SQL and the parameter list of a compiled spec, with values withheld. */
export function explainSpec(spec: QuerySpec): { sql: string; params: ExplainParam[] } {
  return {
    sql: tidy(spec.query),
    params: Object.entries(spec.query_params)
      .map(([name, value]) => ({ name, type: typeOf(value) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/**
 * The capture channels that produced nothing in this window.
 *
 * A channel with a zero count is the single most common reason an Uptimizr
 * answer is empty and wrong: capture is a per-project dial (ADR 0012), and a
 * project that never turned on gaze raycasting has no attention data at all —
 * which is a different statement from "nobody looked at anything".
 */
export function silentChannels(
  metric: MetricDefinition,
  counts: Readonly<Record<string, number>> | undefined,
): readonly EventType[] {
  if (counts == null) return [];
  return metric.sourceChannels.filter((channel) => (counts[channel] ?? 0) === 0);
}

/** Events of the metric's own channels in the window; `null` when unknowable. */
export function channelRows(
  metric: MetricDefinition,
  counts: Readonly<Record<string, number>> | undefined,
): number | null {
  if (counts == null || metric.sourceChannels.length === 0) return null;
  return metric.sourceChannels.reduce((sum, channel) => sum + (counts[channel] ?? 0), 0);
}

/**
 * Every reason this result might not mean what it looks like, in the order a
 * reader should weigh them: no data at all, then too little data, then data that
 * has been cut off, then a presentational limit.
 */
export function planWarnings(
  metric: MetricDefinition,
  ctx: PlanContext,
  sampleSize: SampleSize,
): string[] {
  const warnings: string[] = [];

  const silent = silentChannels(metric, ctx.channelCounts);
  if (silent.length > 0) {
    warnings.push(
      `No \`${silent.join("`, `")}\` events exist in this project over the selected range, and ` +
        `"${metric.id}" is computed from ${metric.sourceChannels.map((c) => `\`${c}\``).join(", ")}. ` +
        "That is almost always a capture channel switched off (ADR 0012), not an absence of " +
        "behaviour — check the project's capture options before reporting a zero.",
    );
  }

  const minSample = metric.comparable?.minSample;
  const observed = sampleSize.events ?? sampleSize.sessions;
  if (minSample != null && observed != null && observed < minSample) {
    warnings.push(
      `Only ${observed} events of this metric's capture channels exist in the selected window; ` +
        `"${metric.id}" declares ${minSample} as the minimum at which a change is worth ` +
        "reporting. Treat the numbers as directional.",
    );
  }

  if (
    (metric.grain === "voxel" || metric.grain === "bin") &&
    ctx.spatial != null &&
    !ctx.spatial.proxy &&
    ctx.spatial.regions === 0
  ) {
    warnings.push(
      "This project has no scene proxy and no registered regions, so spatial results can only be " +
        "reported as grid indices — there is nothing to name a hotspot after. Upload a scene " +
        "proxy (`PUT /api/v1/scenes/:sceneId/proxy`) or register regions to get labels.",
    );
  }

  if (ctx.limit != null && ctx.rows != null && ctx.rows >= ctx.limit) {
    warnings.push(
      `The result hit its ${ctx.limit}-row cap, so totals and shares describe the returned rows ` +
        "only. Narrow the query with a filter rather than raising the cap.",
    );
  }

  warnings.push(...(ctx.extra ?? []));
  return warnings;
}

/** Assemble the plan `explain: true` answers with. */
export function explainQuery(
  metric: MetricDefinition,
  spec: QuerySpec,
  ctx: PlanContext,
): QueryPlan {
  const sampleSize = ctx.sampleSize ?? { sessions: null, events: null };
  const { sql, params } = explainSpec(spec);
  return {
    metric: metric.id,
    tier: ctx.tier,
    dialect: ctx.dialect,
    sql,
    params,
    rowsScanned: channelRows(metric, ctx.channelCounts),
    sampleSize,
    warnings: planWarnings(metric, ctx, sampleSize),
  };
}
