/**
 * Metric-registry checks that need a database (ADR 0051 §1, design sketch §A.3).
 *
 * The registry itself lives in `@uptimizr/metrics` — a dependency-free package,
 * so that the browser and `npx` consumers of the metric catalog never pull in
 * this package's ~37 MB native DuckDB binding. The pure gates (coverage against
 * `AGGREGATION_BUILDER_NAMES`, internal consistency) run there. Two gates can
 * only run here, and both are the reason `@uptimizr/db` depends on
 * `@uptimizr/metrics` rather than the other way round:
 *
 * 1. **The builder link** — `@uptimizr/metrics` declares
 *    `AGGREGATION_BUILDER_NAMES` as literal data instead of deriving it with
 *    `keyof typeof aggregations`, because deriving it would make the registry
 *    depend on this package. The invariant is not lost, only moved from the
 *    compiler to CI: this suite asserts at runtime that the set of `build*`
 *    exports of `aggregations.ts` is **exactly** that list, that every claimed
 *    builder resolves to a real function, and that every builder tags its
 *    `QuerySpec` with the metric that claims it (ADR 0051 §2 — the store edge
 *    coerces by reading that tag, so the two halves of the mapping cannot
 *    drift).
 * 2. **Reality** — every `row` schema parses the rows the aggregation actually
 *    produces, run in-process against DuckDB over the shared parity fixtures.
 * 3. **The edge, not the schema, makes numbers numbers** (ADR 0051 §2) — the
 *    same rows with every number string-encoded (the shape ClickHouse returns
 *    64-bit integers and decimals in over HTTP) must **fail** the strict `row`
 *    schema and **pass** it after `coerceRows`. That is what pins the coercion
 *    to the store edge: if a `z.coerce.number()` ever creeps back into the
 *    registry the first half of this test fails, and if `coerceRows` stops
 *    covering a column the second half does.
 *
 * The invariant: **a new aggregation is not done until it has a registry entry.**
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import {
  AGGREGATION_BUILDER_NAMES,
  METRIC_BY_BUILDER,
  allMetrics,
  getMetric,
  metricForBuilder,
  type MetricId,
} from "@uptimizr/metrics";
import { coerceRows, numericColumns } from "../query/coerce.js";
import * as aggregations from "../query/aggregations.js";
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

describe("metric registry — the builder link", () => {
  it("declares exactly the build* aggregations this package exports", () => {
    const declared = [...AGGREGATION_BUILDER_NAMES].sort();
    const missing = BUILDER_NAMES.filter((name) => !declared.includes(name as never));
    const stale = declared.filter((name) => !BUILDER_NAMES.includes(name));
    expect(
      missing,
      `aggregations missing from @uptimizr/metrics' AGGREGATION_BUILDER_NAMES: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      stale,
      `AGGREGATION_BUILDER_NAMES lists aggregations that no longer exist: ${stale.join(", ")}`,
    ).toEqual([]);
    expect(declared).toEqual(BUILDER_NAMES);
  });

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

  it("resolves a metric from its builder name", () => {
    expect(metricForBuilder("buildTopMeshes")?.id).toBe("top_meshes");
    expect(getMetric("top_meshes")?.builder).toBe("buildTopMeshes");
  });

  it("indexes every claimed builder in the reverse lookup", () => {
    const claimed = allMetrics()
      .filter((metric) => metric.builder != null)
      .map((metric) => metric.builder);
    expect([...METRIC_BY_BUILDER.keys()].sort()).toEqual([...claimed].sort());
    for (const [builder, metric] of METRIC_BY_BUILDER) {
      expect(metric.builder).toBe(builder);
    }
  });

  /**
   * The store edge (ADR 0051 §2) coerces numbers by reading `QuerySpec.metric`.
   * That tag and the registry's `builder` field are two halves of one mapping:
   * if they ever disagree a store would coerce a query against the wrong row
   * schema — silently, because a missing column is simply not coerced. Every
   * builder is rendered here with a throwaway dialect and its tag checked
   * against the reverse lookup.
   */
  it("tags every builder's QuerySpec with the metric that claims it", () => {
    const untagged: string[] = [];
    const mismatched: string[] = [];
    for (const [builder, metric] of METRIC_BY_BUILDER) {
      const build = (aggregations as Record<string, unknown>)[builder];
      if (typeof build !== "function") continue;
      const spec = callBuilder(build as (...args: unknown[]) => QuerySpec, builder);
      if (spec.metric == null) untagged.push(builder);
      else if (spec.metric !== metric.id) mismatched.push(`${builder} → ${spec.metric}`);
    }
    expect(untagged, `builders with no QuerySpec.metric tag: ${untagged.join(", ")}`).toEqual([]);
    expect(mismatched, `builders tagged with the wrong metric: ${mismatched.join(", ")}`).toEqual(
      [],
    );
  });
});

/**
 * Render one aggregation with plausible arguments. Every builder takes
 * `(projectId, options, dialect)`; the three funnel-shaped ones need at least one
 * step predicate in their options to render at all.
 */
function callBuilder(build: (...args: unknown[]) => QuerySpec, name: string): QuerySpec {
  const step = { type: "pointer_click" as const };
  const options: Record<string, unknown> = {
    ...PARITY_RANGE,
    steps: [step, step],
    variant: step,
    conversion: step,
  };
  try {
    return build(PARITY_PROJECT_ID, options, duckdbDialect);
  } catch (error) {
    throw new Error(`${name} failed to render`, { cause: error });
  }
}

/**
 * Which registry metric each parity case exercises. Several cases are filter
 * variants of the same aggregation (a region drill-down, a by-mesh UV heatmap),
 * so the mapping is many-to-one.
 *
 * `null` means the case exercises no metric's row schema: the `metricBuckets:*`
 * cases render the shared insight bucket series (ADR 0051 §4), whose
 * `{ bucket, value, sample_size }` shape is an *input* to `insight_baseline` /
 * `insight_movers` rather than either metric's output row. Those two rows are
 * computed in TypeScript and are covered by the collector's response-schema
 * suite. The mapping still has to name every case, so a new parity case cannot
 * skip this check by omission.
 */
const PARITY_CASE_METRIC: Readonly<Record<string, MetricId | null>> = {
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
  // The shared insight bucket series — an input, not a metric's output row.
  "metricBuckets:count": null,
  "metricBuckets:sessions": null,
  "metricBuckets:quantile": null,
  "metricBuckets:sum": null,
  "metricBuckets:geometry": null,
  "metricBuckets:emptySeries": null,
  "metricBuckets:dayGrain": null,
  // --- significance / scene health (#307) ---
  "metricBuckets:rateDenominator": null,
  "metricBuckets:longFrames": null,
  "metricBuckets:tailQuantile": null,
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
      ...PARITY_CASES.filter((parityCase) => PARITY_CASE_METRIC[parityCase.name] != null).map(
        (parityCase) => ({
          metric: PARITY_CASE_METRIC[parityCase.name] as MetricId,
          build: parityCase.build.bind(parityCase),
        }),
      ),
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
      }
    });
  }

  for (const metric of allMetrics()) {
    if (metric.builder == null) continue;
    it(`coerceRows, not the schema, absorbs string-encoded numbers for ${metric.id}`, () => {
      const rows = produced.get(metric.id) ?? [];
      const numeric = new Set(numericColumns(metric.row));
      for (const row of rows) {
        // The same row as ClickHouse renders it over HTTP: 64-bit integers and
        // decimals arrive as strings.
        const wire = stringifyNumbers(row);
        const affected = Object.keys(row).filter(
          (key) => numeric.has(key) && typeof row[key] === "number",
        );

        // The registry describes the API, not the wire: a string-encoded numeric
        // column must be rejected. (Rows whose numeric columns are all null in
        // the fixtures are unchanged by `stringifyNumbers` and prove nothing.)
        if (affected.length > 0) {
          const strict = metric.row.safeParse(wire);
          expect(
            strict.success,
            `${metric.id}: strict row schema accepted string-encoded ${affected.join(", ")} — ` +
              `has a z.coerce.number() crept back in?`,
          ).toBe(false);
        }

        // …and the store edge is what makes it a number again.
        const [coercedRow] = coerceRows(metric.id, [wire]);
        const coerced = metric.row.safeParse(coercedRow);
        expect(
          coerced.success,
          `${metric.id} (after coerceRows): ${coerced.success ? "" : JSON.stringify(coerced.error.issues)}`,
        ).toBe(true);
        expect(coercedRow, `${metric.id}: coerceRows changed a value`).toEqual(row);
      }
    });
  }
});
