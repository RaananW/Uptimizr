/**
 * Metric-registry coverage checks (ADR 0051 §1, design sketch §A.3).
 *
 * These are the CI gates that keep the registry honest:
 *
 * 1. **Coverage** — every exported `build*` in `aggregations.ts` has exactly one
 *    registry entry (the runtime companion to the `NoUnregisteredAggregations`
 *    compile-time guard in `registry.ts`).
 * 2. **Internal consistency** — ids, column semantics, `related` links and
 *    `comparable` targets all resolve.
 * 3. **Reality** — every `row` schema parses the rows the aggregation actually
 *    produces, run in-process against DuckDB over the shared parity fixtures,
 *    and parses the same rows with every number string-encoded (the shape
 *    ClickHouse returns 64-bit integers and decimals in over HTTP).
 *
 * The invariant: **a new aggregation is not done until it has a registry entry.**
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import * as aggregations from "../query/aggregations.js";
import {
  FILTER_TARGETS,
  METRIC_IDS,
  METRIC_REGISTRY,
  allMetrics,
  getMetric,
  isResourceMetric,
  metricForBuilder,
  type MetricDefinition,
  type MetricId,
} from "../query/registry.js";
import { duckdbDialect } from "../query/duckdbDialect.js";
import type { Dialect } from "../query/dialect.js";
import type { QuerySpec } from "../query/types.js";
import { PARITY_CASES } from "../parity/cases.js";
import { PARITY_PROJECT_ID, PARITY_EVENTS, PARITY_RANGE, PARITY_T0 } from "../parity/fixtures.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/** Every exported `build*` aggregation, discovered at runtime from the module. */
const BUILDER_NAMES = Object.keys(aggregations)
  .filter((name) => name.startsWith("build"))
  .sort();

/**
 * The tool names already shipped by `@uptimizr/agent-core`'s `readTools`
 * (ADR 0017 / ADR 0050). They MUST remain registry ids: when the catalog is
 * generated from the registry (design sketch §A.4) an MCP client that calls
 * `top_meshes` today has to keep working. `@uptimizr/db` cannot depend on
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
  it("registers every exported build* aggregation exactly once", () => {
    const claimed = allMetrics()
      .map((metric) => metric.builder)
      .filter((builder): builder is NonNullable<typeof builder> => builder != null);
    const missing = BUILDER_NAMES.filter((name) => !claimed.includes(name as never));
    expect(missing, `aggregations with no registry entry: ${missing.join(", ")}`).toEqual([]);
    // One entry per builder — no aggregation is described twice.
    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual(BUILDER_NAMES);
  });

  it("claims only builders that actually exist and are functions", () => {
    for (const metric of allMetrics()) {
      if (metric.builder == null) continue;
      const fn = (aggregations as Record<string, unknown>)[metric.builder];
      expect(typeof fn, `${metric.id} -> ${metric.builder}`).toBe("function");
    }
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

  it("resolves a metric from its builder name", () => {
    expect(metricForBuilder("buildTopMeshes")?.id).toBe("top_meshes");
    expect(getMetric("top_meshes")?.builder).toBe("buildTopMeshes");
    expect(getMetric("not_a_metric")).toBeUndefined();
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

  it("uses unique, documented filters and non-empty prose", () => {
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

/**
 * Which registry metric each parity case exercises. Several cases are filter
 * variants of the same aggregation (a region drill-down, a by-mesh UV heatmap),
 * so the mapping is many-to-one.
 */
const PARITY_CASE_METRIC: Readonly<Record<string, MetricId>> = {
  listSessions: "list_sessions",
  pointerHeatmap: "pointer_heatmap",
  meshUvHeatmap: "mesh_uv_heatmap",
  meshUvHeatmapByMesh: "mesh_uv_heatmap",
  worldHeatmap: "world_heatmap",
  worldHeatmapStats: "world_heatmap_stats",
  worldHeatmapRegion: "world_heatmap",
  gazeHeatmap: "gaze_heatmap",
  gazeHeatmapStats: "gaze_heatmap_stats",
  cameraDirectionHeatmap: "camera_heatmap",
  cameraPositionHeatmap: "position_heatmap",
  sessionTrajectory: "session_trajectory",
  aggregateTrajectories: "aggregate_paths",
  clickGazeRay: "click_rays",
  flowHeatmap: "flow_links",
  flowHeatmapByStandpoint: "flow_links",
  topMeshes: "top_meshes",
  meshDwell: "mesh_dwell",
  meshBlindSpots: "mesh_blind_spots",
  topMeshesBySource: "mesh_sources",
  topMeshesTrend: "mesh_trend",
  meshInteractionKinds: "mesh_interaction_kinds",
  reachability: "mesh_reachability",
  topInputActions: "top_input_actions",
  perfSummary: "perf_summary",
  renderScaleTruth: "render_scale_truth",
  perfDistribution: "perf_distribution",
  fpsHistogram: "fps_histogram",
  frameTimePercentiles: "frame_time_percentiles",
  jankRate: "jank_rate",
  perfByDevice: "perf_by_device",
  perfByScene: "perf_by_scene",
  resourcePercentiles: "resource_percentiles",
  stabilityCounts: "stability_counts",
  graphicsDiagnosticCounts: "graphics_diagnostics",
  errorHeatmap: "error_heatmap",
  boundaryHeatmap: "boundary_heatmap",
  boundaryHeatmapStats: "boundary_heatmap_stats",
  boundaryContacts: "xr_boundary_contacts",
  renderingTechnology: "rendering_technology",
  deadClicks: "dead_clicks",
  rageClicks: "rage_clicks",
  hoverDwell: "hover_dwell",
  compileStalls: "compile_stalls",
  arPlacementTimeToPlace: "ar_placement_time_to_place",
  arPlacementAttempts: "ar_placement_attempts",
  arPlacementSurfaces: "ar_placement_surfaces",
  resourceSummary: "resource_summary",
  capabilityChanges: "capability_changes",
  cameraGestures: "camera_gestures",
  perfDaily: "perf_daily",
  eventsDaily: "events_daily",
  distinctScenes: "list_scenes",
  timeseries: "timeseries",
  eventTypeCounts: "event_counts",
  sceneCoverage: "scene_coverage",
  perfHeatmap: "perf_heatmap",
  cameraDistance: "camera_distance",
  navigationStats: "navigation_stats",
  backtrackRatio: "backtrack_ratio",
  xrRotationRate: "xr_rotation",
  xrSourceUsage: "xr_sources",
  xrAbandonment: "xr_abandonment",
  xrLocomotion: "xr_locomotion",
  trackingQuality: "xr_tracking_quality",
  interactionsBySource: "interaction_sources",
  funnel: "funnel",
  loadBounceFunnel: "load_bounce_funnel",
};

/**
 * The four aggregations the parity harness does not cover yet. They are run
 * directly against the same in-memory DuckDB fixtures so the row-schema check
 * stays 69/69 rather than 65/69.
 */
const EXTRA_METRIC_QUERIES: ReadonlyArray<{
  metric: MetricId;
  build: (dialect: Dialect) => QuerySpec;
}> = [
  {
    metric: "view_coverage_histogram",
    build: (d) =>
      aggregations.buildViewCoverageHistogram(PARITY_PROJECT_ID, { ...PARITY_RANGE, bins: 8 }, d),
  },
  {
    metric: "perf_churn",
    build: (d) => aggregations.buildPerfChurn(PARITY_PROJECT_ID, PARITY_RANGE, d),
  },
  {
    metric: "scene_retention",
    build: (d) => aggregations.buildSceneRetention(PARITY_PROJECT_ID, PARITY_RANGE, d),
  },
  {
    metric: "variant_leaderboard",
    build: (d) => aggregations.buildVariantLeaderboard(PARITY_PROJECT_ID, PARITY_RANGE, d),
  },
];

/**
 * Extra fixture events, local to this suite.
 *
 * The shared `PARITY_EVENTS` set deliberately leaves eighteen channels empty
 * (their parity goldens are `[]` — they prove the SQL renders identically on
 * both engines, not that it groups). An empty result would let those metrics'
 * row schemas pass vacuously here, so this suite seeds the missing channels on
 * top of the shared fixtures: XR interactions and locomotion, tracking and
 * capability transitions, input actions, hover and compile stalls, AR
 * placements, a rage-click burst, scene changes, custom variants and asset
 * loads.
 *
 * These events are **not** added to `PARITY_EVENTS`: the goldens in
 * `parity/cases.ts` are hand-verified against that exact event set and every
 * engine's parity suite compares against them.
 */
const T = PARITY_T0 + 20_000;

function extra(type: string, ts: number, extras: Record<string, unknown> = {}): AnyEvent {
  return {
    type,
    projectId: PARITY_PROJECT_ID,
    sessionId: "s1",
    ts,
    sdkVersion: "0.1.0",
    sceneId: "lobby",
    ...extras,
  } as AnyEvent;
}

/** Session `s3` is an XR session; `s1` / `s2` gain the flat-screen channels. */
const REGISTRY_EXTRA_EVENTS: readonly AnyEvent[] = [
  // --- s3: an XR session (scene `lobby`) ---
  extra("session_start", T, {
    sessionId: "s3",
    scene: { cameraType: "free", cameraName: "cam3", meshCount: 4 },
    device: { engine: "webgpu" },
    graphics: { api: "webgpu", backend: "vulkan", apiVersion: "1.0", shadingLanguage: "wgsl" },
  }),
  extra("asset_load", T + 500, { sessionId: "s3", name: "scene.glb", loadMs: 2400 }),
  extra("camera_sample", T + 1_000, {
    sessionId: "s3",
    position: [1, 0, 1],
    direction: [1, 0, 0],
    hitPoint: [2, 0, 1],
  }),
  extra("mesh_interaction", T + 2_000, {
    sessionId: "s3",
    kind: "pick",
    mesh: "lever",
    point: [3, 0, 1],
    source: "xr-controller",
  }),
  extra("mesh_interaction", T + 2_500, {
    sessionId: "s3",
    kind: "teleport",
    mesh: "floor",
    point: [4, 0, 1],
    source: "xr-controller",
  }),
  extra("camera_gesture", T + 3_000, {
    sessionId: "s3",
    kind: "fly",
    durationMs: 1_200,
    source: "xr-controller",
  }),
  extra("camera_gesture", T + 3_500, {
    sessionId: "s3",
    kind: "navigate",
    durationMs: 800,
    source: "xr-controller",
  }),
  extra("capability_change", T + 4_000, {
    sessionId: "s3",
    kind: "tracking",
    from: "tracked",
    to: "degraded",
    source: "hand",
    durationMs: 400,
  }),

  // --- s1: flat-screen channels ---
  extra("capability_change", T + 4_500, {
    kind: "graphics-backend",
    from: "webgpu",
    to: "webgl2",
  }),
  extra("input_action", T + 5_000, { action: "rotate-left", source: "keyboard" }),
  extra("hover_dwell", T + 5_500, { mesh: "box", dwellMs: 900 }),
  extra("compile_stall", T + 6_000, { phase: "shader", durationMs: 120 }),
  // Two ordered scene markers, so the retention funnel has one directed link.
  extra("scene_change", T + 9_000, { sceneId: "hall" }),
  extra("scene_change", T + 9_500, { sceneId: "arena" }),

  // --- s2: AR placements, a rage burst, and configurator variants ---
  extra("asset_load", T + 6_450, {
    sessionId: "s2",
    sceneId: "arena",
    name: "arena.glb",
    loadMs: 6_000,
  }),
  extra("ar_placement", T + 6_500, {
    sessionId: "s2",
    sceneId: "arena",
    mesh: "chair",
    timeToPlaceMs: 3_200,
    attempts: 2,
    surface: "floor",
    scale: 1.1,
  }),
  extra("ar_placement", T + 7_000, {
    sessionId: "s2",
    sceneId: "arena",
    mesh: "chair",
    timeToPlaceMs: 1_500,
    attempts: 1,
    surface: "wall",
    scale: 0.9,
  }),
  // Three clicks on one mesh inside a single 2 s window — a rage cluster.
  extra("pointer_click", T + 8_000, {
    sessionId: "s2",
    sceneId: "arena",
    screen: [0.5, 0.5],
    hitPoint: [1, 1, 1],
    hitMesh: "button",
    uv: [0.5, 0.5],
    button: 0,
    source: "mouse",
  }),
  extra("pointer_click", T + 8_200, {
    sessionId: "s2",
    sceneId: "arena",
    screen: [0.5, 0.5],
    hitPoint: [1, 1, 1],
    hitMesh: "button",
    uv: [0.5, 0.5],
    button: 0,
    source: "mouse",
  }),
  extra("pointer_click", T + 8_400, {
    sessionId: "s2",
    sceneId: "arena",
    screen: [0.5, 0.5],
    hitPoint: [1, 1, 1],
    hitMesh: "button",
    uv: [0.5, 0.5],
    button: 0,
    source: "mouse",
  }),
  extra("custom", T + 10_000, { sessionId: "s2", sceneId: "arena", name: "red" }),
  extra("custom", T + 10_500, { sessionId: "s2", sceneId: "arena", name: "blue" }),
];

/**
 * Metrics whose result is still empty even with the extra channels seeded, so
 * their row schema is asserted structurally rather than against real rows.
 * Pinned so a fixture change that silently empties a metric surfaces here
 * instead of passing vacuously.
 */
const EMPTY_AGAINST_FIXTURES: readonly MetricId[] = [];

/** Render every JSON number in a row as a string — the ClickHouse HTTP shape. */
function stringifyNumbers(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "number" ? String(value) : value;
  }
  return out;
}

describe("metric registry — row schemas against real DuckDB output", () => {
  let db: DuckdbClient;
  /** metric id -> the rows every query for that metric produced. */
  const produced = new Map<MetricId, Record<string, unknown>[]>();

  beforeAll(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
    await insertEvents(db, [...PARITY_EVENTS, ...REGISTRY_EXTRA_EVENTS]);

    const queries: ReadonlyArray<{ metric: MetricId; build: (d: Dialect) => QuerySpec }> = [
      ...PARITY_CASES.map((parityCase) => ({
        metric: PARITY_CASE_METRIC[parityCase.name] as MetricId,
        build: parityCase.build.bind(parityCase),
      })),
      ...EXTRA_METRIC_QUERIES,
    ];

    for (const query of queries) {
      const rows = await runDuckdbQuery<Record<string, unknown>>(db, query.build(duckdbDialect));
      const existing = produced.get(query.metric) ?? [];
      produced.set(query.metric, [...existing, ...rows]);
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it("maps every parity case to a registry metric", () => {
    const unmapped = PARITY_CASES.map((c) => c.name).filter(
      (name) => !(name in PARITY_CASE_METRIC),
    );
    expect(unmapped, `parity cases with no registry metric: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("exercises every aggregation's row schema", () => {
    const aggregationMetrics = allMetrics()
      .filter((metric) => metric.builder != null)
      .map((metric) => metric.id);
    const uncovered = aggregationMetrics.filter((id) => !produced.has(id)).sort();
    expect(uncovered, `aggregations with no row-schema evidence: ${uncovered.join(", ")}`).toEqual(
      [],
    );
  });

  it("produces rows for every aggregation except the pinned empty ones", () => {
    const empty = [...produced.entries()]
      .filter(([, rows]) => rows.length === 0)
      .map(([id]) => id)
      .sort();
    expect(empty).toEqual([...EMPTY_AGAINST_FIXTURES].sort());
  });

  for (const metric of allMetrics()) {
    if (metric.builder == null) continue;
    it(`row schema parses ${metric.id}`, () => {
      const rows = produced.get(metric.id) ?? [];
      const known = new Set(Object.keys(metric.row.shape));
      for (const row of rows) {
        const extra = Object.keys(row).filter((key) => !known.has(key));
        expect(extra, `${metric.id}: undeclared columns ${extra.join(", ")}`).toEqual([]);

        const parsed = metric.row.safeParse(row);
        expect(
          parsed.success,
          `${metric.id}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`,
        ).toBe(true);

        // The same row as ClickHouse renders it over HTTP: 64-bit integers and
        // decimals arrive as strings. `z.coerce.number()` must absorb that.
        const coerced = metric.row.safeParse(stringifyNumbers(row));
        expect(
          coerced.success,
          `${metric.id} (string-encoded numbers): ${coerced.success ? "" : JSON.stringify(coerced.error.issues)}`,
        ).toBe(true);
      }
    });
  }
});
