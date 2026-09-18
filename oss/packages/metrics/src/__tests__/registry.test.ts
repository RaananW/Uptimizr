/**
 * Metric-registry coverage and consistency checks (ADR 0051 §1, design sketch §A.3).
 *
 * These are the pure CI gates — no database, no driver, no I/O:
 *
 * 1. **Coverage** — every name in `AGGREGATION_BUILDER_NAMES` has exactly one
 *    registry entry (the runtime companion to the `NoUnregisteredAggregations`
 *    compile-time guard in `registry.ts`).
 * 2. **Internal consistency** — ids, column semantics, `related` links and
 *    `comparable` targets all resolve.
 *
 * The third gate — **reality**, i.e. every `row` schema parses the rows the
 * aggregation actually produces — needs a database and therefore lives in
 * `@uptimizr/db`'s `src/__tests__/registry.test.ts`, alongside the check that
 * `AGGREGATION_BUILDER_NAMES` still equals the real `build*` exports of
 * `aggregations.ts`.
 *
 * The invariant: **a new aggregation is not done until it has a registry entry.**
 */

import { describe, expect, it } from "vitest";
import {
  AGGREGATION_BUILDER_NAMES,
  DIMENSION_COLUMNS,
  FILTER_TARGETS,
  METRIC_IDS,
  METRIC_REGISTRY,
  allMetrics,
  getMetric,
  isAggregateMetric,
  isDerivedMetric,
  isMetricId,
  isResourceMetric,
  metricForBuilder,
  type MetricDefinition,
} from "../registry.js";

/**
 * The tool names already shipped by `@uptimizr/agent-core`'s `readTools`
 * (ADR 0017 / ADR 0050). They MUST remain registry ids: the generated catalog
 * (design sketch §A.4) uses the id as the tool name, so an MCP client that calls
 * `top_meshes` today has to keep working. `@uptimizr/metrics` cannot depend on
 * `agent-core`, so the list is mirrored here and guarded by this test.
 */
const SHIPPED_TOOL_NAMES = [
  "list_sessions",
  "pointer_heatmap",
  "world_heatmap",
  "camera_heatmap",
  "click_rays",
  "flow_links",
  "top_meshes",
  "perf_summary",
  "list_scenes",
  "timeseries",
  "event_counts",
  "session_meta",
  "scene_representation",
  "funnel",
  "aggregate_paths",
  "rendering_technology",
  "xr_rotation",
  "xr_sources",
  "xr_abandonment",
  "xr_locomotion",
] as const;

describe("metric registry — coverage", () => {
  it("registers every declared build* aggregation exactly once", () => {
    const claimed = allMetrics()
      .map((metric) => metric.builder)
      .filter((builder): builder is NonNullable<typeof builder> => builder != null);
    const declared = [...AGGREGATION_BUILDER_NAMES].sort();
    const missing = declared.filter((name) => !claimed.includes(name));
    expect(missing, `declared aggregations with no registry entry: ${missing.join(", ")}`).toEqual(
      [],
    );
    // One entry per builder — no aggregation is described twice.
    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual(declared);
  });

  it("declares the builder-name list as a sorted set of build* names", () => {
    const names = [...AGGREGATION_BUILDER_NAMES];
    expect(new Set(names).size, "duplicate builder name").toBe(names.length);
    expect(names).toEqual([...names].sort());
    for (const name of names) expect(name).toMatch(/^build[A-Z][A-Za-z0-9]*$/);
  });

  it("keeps the shipped agent tool names as registry ids", () => {
    for (const name of SHIPPED_TOOL_NAMES) {
      expect(METRIC_IDS, `tool name '${name}' must stay a registry id`).toContain(name);
    }
  });

  it("marks exactly the two store resources as builder-less", () => {
    const resources = allMetrics()
      .filter(isResourceMetric)
      .map((metric) => metric.id)
      .sort();
    expect(resources).toEqual(["scene_representation", "session_meta"]);
  });

  it("marks the insight primitives as derived rather than as resources", () => {
    const derived = allMetrics()
      .filter(isDerivedMetric)
      .map((metric) => metric.id)
      .sort();
    expect(derived).toEqual(["insight_anomalies", "insight_baseline", "insight_movers"]);
    for (const metric of allMetrics().filter(isDerivedMetric)) {
      // A derived metric has no `build*` aggregation, but unlike a resource it
      // is a real aggregate: an endpoint, a querystring, a time range and the
      // `format` envelope. Confusing the two would drop it out of the summary
      // surface and out of OpenAPI's parameter list.
      expect(metric.builder, `${metric.id} must not claim a builder`).toBeUndefined();
      expect(isResourceMetric(metric), `${metric.id} is not a resource`).toBe(false);
      expect(isAggregateMetric(metric), `${metric.id} is an aggregate`).toBe(true);
      expect(metric.endpoint?.path, `${metric.id} endpoint`).toMatch(/^\/api\/v1\/insights\//);
      expect(metric.filters, `${metric.id} range`).toContain("since");
      expect(metric.filters, `${metric.id} range`).toContain("until");
      expect(metric.category).toBe("insights");
    }
  });

  it("resolves a metric from its builder name", () => {
    expect(metricForBuilder("buildTopMeshes")?.id).toBe("top_meshes");
    expect(getMetric("top_meshes")?.builder).toBe("buildTopMeshes");
    expect(getMetric("not_a_metric")).toBeUndefined();
    expect(isMetricId("top_meshes")).toBe(true);
    expect(isMetricId("not_a_metric")).toBe(false);
  });
});

describe("metric registry — internal consistency", () => {
  const metrics = allMetrics();

  it("uses snake_case ids that match their registry key", () => {
    for (const id of METRIC_IDS) {
      const metric = METRIC_REGISTRY[id] as MetricDefinition;
      expect(metric.id, `key '${id}' and id '${metric.id}' disagree`).toBe(id);
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("describes exactly the columns the row schema declares", () => {
    for (const metric of metrics) {
      const rowKeys = Object.keys(metric.row.shape).sort();
      const columnKeys = Object.keys(metric.columns).sort();
      expect(columnKeys, `${metric.id}: columns/row mismatch`).toEqual(rowKeys);
    }
  });

  it("declares at most one measure and one label column, and resolvable rateOf", () => {
    for (const metric of metrics) {
      const entries = Object.entries(metric.columns);
      expect(
        entries.filter(([, column]) => column.measure === true).length,
        `${metric.id}: more than one measure column`,
      ).toBeLessThanOrEqual(1);
      expect(
        entries.filter(([, column]) => column.label === true).length,
        `${metric.id}: more than one label column`,
      ).toBeLessThanOrEqual(1);
      for (const [name, column] of entries) {
        if (column.rateOf == null) continue;
        expect(metric.columns[column.rateOf], `${metric.id}.${name}.rateOf`).toBeDefined();
      }
    }
  });

  it("marks exactly one ordered axis column on every bucket-grain metric", () => {
    for (const metric of metrics) {
      const axes = Object.entries(metric.columns).filter(([, column]) => column.axis === true);
      if (metric.grain === "bucket") {
        // Without an axis a time series cannot be walked in order, and `label`
        // cannot stand in for it (`mesh_trend` labels its rows by mesh).
        expect(
          axes.map(([name]) => name),
          `${metric.id}: bucket grain needs one axis`,
        ).toHaveLength(1);
      } else {
        expect(
          axes.map(([name]) => name),
          `${metric.id}: axis on a ${metric.grain} grain`,
        ).toEqual([]);
      }
    }
  });

  it("offers every aggregate endpoint the shared `format` filter", () => {
    for (const metric of metrics) {
      // The two resource reads take no querystring at all; the daily rollups are
      // not served on an endpoint. Everything else — aggregations and the
      // derived insight primitives alike — must accept an envelope.
      const servedOnAQuerystring = metric.endpoint != null && isAggregateMetric(metric);
      expect(
        metric.filters.includes("format"),
        `${metric.id}: format filter ${servedOnAQuerystring ? "missing" : "should not be declared"}`,
      ).toBe(servedOnAQuerystring);
    }
  });

  it("gives every binned or voxelised metric enough index columns to cluster", () => {
    for (const metric of metrics) {
      if (metric.grain !== "bin" && metric.grain !== "voxel") continue;
      const indexed = Object.entries(metric.columns).filter(
        ([, column]) => column.unit === "index",
      );
      expect(
        indexed.length,
        `${metric.id}: a ${metric.grain} grain needs ${metric.grain === "voxel" ? 3 : 2} index columns`,
      ).toBeGreaterThanOrEqual(metric.grain === "voxel" ? 3 : 2);
    }
  });

  it("points comparable.primary at a real column", () => {
    for (const metric of metrics) {
      if (metric.comparable == null) continue;
      expect(
        metric.columns[metric.comparable.primary],
        `${metric.id}: comparable.primary '${metric.comparable.primary}' is not a column`,
      ).toBeDefined();
      expect(metric.comparable.minSample).toBeGreaterThan(0);
    }
  });

  it("links only to metrics that exist, never to itself", () => {
    for (const metric of metrics) {
      for (const related of metric.related) {
        expect(METRIC_IDS, `${metric.id} -> ${related}`).toContain(related);
        expect(related, `${metric.id} relates to itself`).not.toBe(metric.id);
      }
    }
  });

  it("uses unique, documented filters and dimensions, and non-empty prose", () => {
    for (const metric of metrics) {
      expect(new Set(metric.filters).size, `${metric.id}: duplicate filters`).toBe(
        metric.filters.length,
      );
      for (const filter of metric.filters) {
        expect(
          FILTER_TARGETS[filter],
          `${metric.id}: undocumented filter '${filter}'`,
        ).toBeDefined();
      }
      for (const dimension of metric.dimensions) {
        expect(
          DIMENSION_COLUMNS[dimension],
          `${metric.id}: undocumented dimension '${dimension}'`,
        ).toBeDefined();
      }
      expect(metric.title.length, `${metric.id}: empty title`).toBeGreaterThan(0);
      expect(metric.description.length, `${metric.id}: thin description`).toBeGreaterThan(60);
      expect(metric.interpretation.length, `${metric.id}: thin interpretation`).toBeGreaterThan(40);
      expect(metric.caveats.length, `${metric.id}: no caveats`).toBeGreaterThan(0);
      expect(metric.limits.maxRows).toBeGreaterThan(0);
      expect(metric.limits.maxSummaryRows).toBeGreaterThan(0);
      expect(metric.limits.maxSummaryRows).toBeLessThanOrEqual(metric.limits.maxRows);
    }
  });

  it("gives every aggregation an endpoint except the two daily rollups", () => {
    const withoutEndpoint = metrics
      .filter((metric) => metric.endpoint == null)
      .map((metric) => metric.id)
      .sort();
    expect(withoutEndpoint).toEqual(["events_daily", "perf_daily"]);
  });
});

describe("metric registry — purity", () => {
  it("declares no dependency beyond zod and @uptimizr/schema", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["@uptimizr/schema", "zod"]);
    expect(manifest.peerDependencies ?? {}).toEqual({});
  });

  it("imports no node: built-in and no database driver", async () => {
    const { readFile } = await import("node:fs/promises");
    // Matched in `from "…"` position only, so the prose in this package's doc
    // comments (which names `@uptimizr/db` and `@duckdb/node-api` to explain why
    // they are absent) cannot trip it.
    const forbidden = /from\s+"(node:[^"]*|@uptimizr\/db[^"]*|@duckdb\/[^"]*|[^"]*duckdb[^"]*)"/;
    for (const file of ["../registry.ts", "../index.ts"]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      const match = forbidden.exec(source);
      expect(match?.[1], `${file} imports a disallowed module: ${match?.[1]}`).toBeUndefined();
    }
  });
});
