import { EVENT_TYPES, SCHEMA_VERSION, type EventType } from "@uptimizr/schema";
import { z } from "zod";
import {
  FILTER_TARGETS,
  allMetrics,
  isResourceMetric,
  type ColumnSemantics,
  type DimensionId,
  type FilterId,
  type MetricCategory,
  type MetricComparison,
  type MetricDefinition,
  type MetricGrain,
} from "@uptimizr/db/registry";

/**
 * One tool the server exposes, described for self-discovery: its name, a human
 * title, what it returns, and the parameter names it accepts.
 *
 * Derived from the **semantic metric registry** (`@uptimizr/db/registry`, ADR
 * 0051 §1) rather than restated here, so the catalog cannot drift from the
 * metrics the collector can actually compute. `params` are the request
 * parameters of the underlying query endpoint — the definitive *input schema*
 * of a registered MCP tool is the one returned by `tools/list`.
 */
export interface CapabilityToolDescriptor {
  name: string;
  title: string;
  description: string;
  params: readonly string[];
}

/** A parameter name and what it means, shared across tools. */
export interface CapabilityParamDescriptor {
  name: string;
  description: string;
}

/**
 * One registry metric, serialised for an agent: everything in the registry
 * entry except the SQL `builder` (an implementation detail with no meaning
 * outside `@uptimizr/db`), with the Zod `row` schema replaced by its JSON
 * Schema so a client with no Zod can still validate or shape a result.
 */
export interface CapabilityMetricDescriptor {
  id: string;
  title: string;
  description: string;
  category: MetricCategory;
  /** What one row represents. */
  grain: MetricGrain;
  /** The collector route it is served on, when it has one. */
  endpoint?: { method: "GET"; path: string; pathParams?: readonly FilterId[] };
  /** Group-by dimensions the rows are keyed by. */
  dimensions: readonly DimensionId[];
  /** Accepted request parameters. */
  filters: readonly FilterId[];
  /** JSON Schema of one result row. */
  row: Record<string, unknown>;
  /** Per-column semantics: description, unit, which column is the measure/label. */
  columns: Readonly<Record<string, ColumnSemantics>>;
  /** Registry-declared caps, so no consumer asks for an unbounded payload. */
  limits: { maxRows: number; maxSummaryRows: number };
  /** How to read the result. */
  interpretation: string;
  /** Small-sample, capture-gating and sampling-rate warnings. */
  caveats: readonly string[];
  /** Capture channels (ADR 0012) that must be enabled for it to have data. */
  sourceChannels: readonly EventType[];
  related: readonly string[];
  comparable?: MetricComparison;
  /**
   * `true` for a **resource** read (a single stored object such as a session
   * descriptor) rather than an aggregation over the event stream.
   */
  resource: boolean;
}

/**
 * Machine-readable capabilities/schema descriptor an agent can read (via the
 * `uptimizr://capabilities` resource) to learn what it can ask before guessing.
 * It is strictly a description of the **read-only** surface — event types, the
 * metric registry, the tool catalog, and parameter semantics — and never itself
 * queries any data.
 */
export interface CapabilitiesDescriptor {
  /** Wire-format version of the event schema (`@uptimizr/schema`). */
  schemaVersion: string;
  /** The MCP surface is read-only: aggregate queries only, no raw events/PII. */
  readOnly: true;
  /** Canonical analytics event types (the single source of truth). */
  eventTypes: readonly EventType[];
  /** Glossary of every query parameter the tools accept. */
  params: readonly CapabilityParamDescriptor[];
  /** The read-only tool catalog (each entry is one aggregate query endpoint). */
  tools: readonly CapabilityToolDescriptor[];
  /**
   * The full semantic metric registry: units, grain, dimensions, row schema,
   * limits, interpretation and caveats per metric (ADR 0051 §1).
   */
  metrics: readonly CapabilityMetricDescriptor[];
  /** Human-oriented notes about scope and discovery. */
  notes: readonly string[];
}

/** Every request parameter a metric accepts: its path params, then its filters. */
function paramsOf(metric: MetricDefinition): readonly FilterId[] {
  return [...(metric.endpoint?.pathParams ?? []), ...metric.filters];
}

/** Serialise one registry entry, dropping `builder` and unwrapping `row`. */
function toMetricDescriptor(metric: MetricDefinition): CapabilityMetricDescriptor {
  const row = z.toJSONSchema(metric.row, {
    io: "output",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete row.$schema;
  return {
    id: metric.id,
    title: metric.title,
    description: metric.description,
    category: metric.category,
    grain: metric.grain,
    ...(metric.endpoint ? { endpoint: metric.endpoint } : {}),
    dimensions: metric.dimensions,
    filters: metric.filters,
    row,
    columns: metric.columns,
    limits: metric.limits,
    interpretation: metric.interpretation,
    caveats: metric.caveats,
    sourceChannels: metric.sourceChannels,
    related: metric.related,
    ...(metric.comparable ? { comparable: metric.comparable } : {}),
    resource: isResourceMetric(metric),
  };
}

/**
 * Build the capabilities descriptor from the metric registry and the event
 * schema. Pure and synchronous — it introspects definitions only, never the
 * collector, so it is safe to serve as a static resource.
 */
export function buildCapabilities(): CapabilitiesDescriptor {
  const metrics = allMetrics();
  const served = metrics.filter((metric) => metric.endpoint != null);

  const tools: CapabilityToolDescriptor[] = served.map((metric) => ({
    name: metric.id,
    title: metric.title,
    description: metric.description,
    params: paramsOf(metric),
  }));

  const usedParams = new Set<FilterId>();
  for (const metric of served) for (const param of paramsOf(metric)) usedParams.add(param);

  const params: CapabilityParamDescriptor[] = [...usedParams]
    .sort()
    .map((name) => ({ name, description: FILTER_TARGETS[name].description }));

  return {
    schemaVersion: SCHEMA_VERSION,
    readOnly: true,
    eventTypes: EVENT_TYPES,
    params,
    tools,
    metrics: metrics.map(toMetricDescriptor),
    notes: [
      "This MCP surface is strictly read-only: aggregate, privacy-preserving queries only. " +
        "There are no ingestion, mutation, or raw per-session event tools (ADR 0003 / ADR 0017).",
      "`metrics` is the collector's semantic metric registry (ADR 0051 §1): for each metric it " +
        "gives the result `grain` (what one row is), the `columns` with their units, the JSON " +
        "Schema of a row, `limits`, how to read it (`interpretation`) and how far to trust it " +
        "(`caveats`). Read a metric's caveats before quoting its numbers.",
      "`sourceChannels` names the capture channels (ADR 0012) that feed a metric. If a project " +
        "has that channel disabled or sampled down, the metric is empty or proportional rather " +
        "than exact — say so instead of reporting a zero as a finding.",
      "`tools` lists the registry's served read surface and the request parameters of each " +
        "underlying endpoint. It is exactly the set this server registers, because the tool " +
        "catalog is generated from the same registry (ADR 0051 §1) — the authoritative input " +
        "and output schemas of a registered tool are still the ones returned by `tools/list`.",
      "Enumerate the concrete scene ids for the `scene` parameter with the uptimizr://scenes " +
        "resource or the list_scenes tool; enumerate sessions with the list_sessions tool.",
      "All time ranges use epoch-millisecond `since`/`until`. Omit both for all-time.",
      "The same registry drives the collector's OpenAPI document at GET /api/v1/openapi.json, " +
        "which describes every endpoint below with its parameters and response schema.",
    ],
  };
}
