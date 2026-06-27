import { describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildApp } from "../app.js";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";

const config: CollectorConfig = {
  host: "127.0.0.1",
  port: 0,
  corsOrigins: [],
  visitorHashSecret: "test-secret",
  enableRawSessionRetention: false,
  liveWindowMs: 30_000,
  liveTokenSecret: "test-live-secret",
  liveTokenSecretIsDedicated: true,
  liveTokenTtlMs: 900_000,
  liveMaxConnections: 200,
  livePresenceIntervalMs: 2_000,
  rateLimitMax: 1000,
  rateLimitWindowMs: 60_000,
  ingestRateLimitMax: 1000,
  ingestRateLimitWindowMs: 60_000,
  trustProxy: false,
  bodyLimit: 1_048_576,
  cspMode: "strict",
};

function makeStore(overrides: Partial<CollectorStore> = {}): CollectorStore & {
  inserted: AnyEvent[];
} {
  const inserted: AnyEvent[] = [];
  return {
    inserted,
    resolveApiKey: async (key) =>
      key === "valid-key"
        ? { projectId: "p1", capability: "query" }
        : key === "ingest-key"
          ? { projectId: "p1", capability: "ingest" }
          : null,
    projectExists: async (id) => id === "p1",
    insertEvents: async (events) => {
      inserted.push(...events);
    },
    listSessions: async () => [
      {
        session_id: "s1",
        visitor_id: "v1",
        events: 3,
        started_at: "2024-06-16 10:00:00.000",
        ended_at: "2024-06-16 10:05:00.000",
      },
    ],
    pointerHeatmap: async () => [{ gx: 1, gy: 2, count: 5 }],
    worldHeatmap: async () => [{ vx: 1, vy: 0, vz: -2, count: 7 }],
    worldHeatmapStats: async () => ({ cells: 12, hits: 34 }),
    gazeHeatmap: async () => [{ vx: 3, vy: 1, vz: -1, count: 6 }],
    gazeHeatmapStats: async () => ({ cells: 5, hits: 9 }),
    cameraHeatmap: async () => [],
    clickGazeRays: async () => [
      {
        cam_vx: 0,
        cam_vy: 1,
        cam_vz: 0,
        origin_x: 0.1,
        origin_y: 1.6,
        origin_z: 0.2,
        hit_vx: 2,
        hit_vy: 0,
        hit_vz: -4,
        hit_x: 1.05,
        hit_y: 0.2,
        hit_z: -2.1,
        mesh: "Cube",
        count: 4,
      },
    ],
    flowHeatmap: async () => [{ azimuth_bin: 8, elevation_bin: 15, mesh: "Cube", count: 11 }],
    topMeshes: async () => [{ mesh: "Cube", count: 9 }],
    meshDwell: async () => [
      { mesh: "Cube", visible_ms: 5000, centered_ms: 2000, max_screen_fraction: 0.51, samples: 2 },
    ],
    deadClicks: async () => [{ total_clicks: 10, dead_clicks: 3 }],
    rageClicks: async () => [
      { session_id: "s1", mesh: "Button", bucket: 1718532000000, clicks: 4 },
    ],
    hoverDwell: async () => [{ mesh: "Button", dwell_ms: 4200, max_dwell_ms: 1800, episodes: 5 }],
    compileStalls: async () => [
      { phase: "shader", stalls: 7, total_ms: 210, avg_ms: 30, max_ms: 64 },
    ],
    resourceSummary: async () => [
      {
        samples: 4,
        avg_js_heap_bytes: 50_000_000,
        max_js_heap_bytes: 80_000_000,
        avg_triangles: 150_000,
        max_triangles: 240_000,
        avg_vertices: 110_000,
        max_vertices: 130_000,
        avg_texture_bytes: 2_000_000,
        max_texture_bytes: 3_000_000,
        avg_geometry_bytes: 600_000,
        max_geometry_bytes: 700_000,
      },
    ],
    capabilityChanges: async () => [
      { kind: "graphics-backend", from: "webgpu", to: "webgl2", changes: 12 },
    ],
    cameraGestures: async () => [
      { kind: "orbit", gestures: 9, total_ms: 4500, avg_ms: 500, max_ms: 1200 },
    ],
    perfSummary: async () => [{ samples: 1, avg_fps: 60, min_fps: 55, p50_fps: 60 }],
    perfDistribution: async () => [
      { sessions: 3, samples: 120, p05_fps: 28, p50_fps: 58, p95_fps: 60 },
    ],
    fpsHistogram: async () => [
      { bucket: 50, sessions: 2 },
      { bucket: 60, sessions: 1 },
    ],
    frameTimePercentiles: async () => [{ sessions: 3, samples: 120, p50_ms: 16, p95_ms: 33 }],
    jankRate: async () => [
      { sessions: 3, total_long_frames: 14, median_rate: 2, worst_decile_rate: 5 },
    ],
    perfByDevice: async () => [
      {
        engine: "webgpu",
        is_mobile: "false",
        renderer: "M3",
        sessions: 2,
        samples: 80,
        p50_fps: 60,
      },
    ],
    perfByScene: async () => [{ scene_id: "lobby", sessions: 2, samples: 80, p50_fps: 58 }],
    resourcePercentiles: async () => [
      {
        sessions: 3,
        samples: 60,
        p50_js_heap_bytes: 50_000_000,
        p95_js_heap_bytes: 80_000_000,
        p50_texture_bytes: 2_000_000,
        p95_texture_bytes: 3_000_000,
        p50_triangles: 150_000,
        p95_triangles: 240_000,
      },
    ],
    stabilityCounts: async () => [{ context_losses: 1, compile_stalls: 2, incidents: 3 }],
    sceneCoverage: async () => [{ vx: 0, vy: 0, vz: 0, count: 3 }],
    cameraDistance: async () => [{ bucket: 2, count: 4 }],
    navigationStats: async () => [
      {
        session_id: "s1",
        segments: 5,
        total_distance: 12.5,
        active_segments: 3,
        active_distance: 11,
      },
    ],
    xrRotationRate: async () => [
      {
        session_id: "s1",
        samples: 8,
        avg_turn_rad: 0.3,
        max_turn_rad: 1.2,
        total_turn_rad: 2.4,
        rapid_segments: 2,
      },
    ],
    xrSourceUsage: async () => [
      { source: "hand", interactions: 9, sessions: 2 },
      { source: "xr-controller", interactions: 4, sessions: 1 },
    ],
    xrAbandonment: async () => [
      {
        session_id: "s1",
        events: 30,
        xr_interactions: 6,
        started_at: "2024-06-16 10:00:00.000",
        ended_at: "2024-06-16 10:00:08.000",
      },
    ],
    interactionsBySource: async () => [
      { event_type: "pointer_click", source: "mouse", count: 18, sessions: 3 },
      { event_type: "mesh_interaction", source: "xr-controller", count: 5, sessions: 2 },
    ],
    scenes: async () => [{ scene_id: "lobby", events: 42, last_seen: "2024-06-16 10:05:00.000" }],
    timeseries: async () => [{ bucket: 1718532000000, events: 12, avg_fps: 59.5 }],
    eventTypeCounts: async () => [{ event_type: "pointer_move", count: 30 }],
    funnel: async () => [
      { step: 0, sessions: 10 },
      { step: 1, sessions: 4 },
    ],
    getSessionEvents: async () => [],
    streamSessionEvents: async function* () {},
    getSessionMeta: async () => ({
      sessionId: "s1",
      startedAt: "2024-06-16 10:00:00.000",
      device: { engine: "webgl2" },
      scene: { cameraType: "arc-rotate", cameraName: "camera", meshCount: 6 },
      user: { id: "anon_abc" },
    }),
    putSceneProxy: async (projectId, proxy, label) => ({
      projectId,
      sceneId: proxy.sceneId,
      label: label ?? null,
      kind: "proxy" as const,
      upAxis: proxy.upAxis,
      unitScale: proxy.unitScale,
      bounds: proxy.bounds,
      proxy,
      assetUrl: null,
      contentHash: proxy.contentHash,
      proxyVersion: proxy.version,
      capturedAt: new Date(proxy.capturedAt),
      updatedAt: new Date(0),
    }),
    getSceneRepresentation: async () => null,
    listSceneRepresentations: async () => [],
    close: async () => {},
    ...overrides,
  };
}

function sessionStart(): AnyEvent {
  return {
    type: "session_start",
    projectId: "p1",
    sessionId: "s1",
    ts: Date.now(),
    sdkVersion: "0.1.0",
  } as AnyEvent;
}

describe("collector app", () => {
  it("responds to health checks", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("accepts a valid batch and enriches the visitor id", async () => {
    const store = makeStore();
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/collect",
      payload: { schemaVersion: "1.0", events: [sessionStart()] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1, rejected: 0 });
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]!.visitorId).toMatch(/^[a-f0-9]{32}$/);
    await app.close();
  });

  it("derives a coarse browser/os onto session_start.device from the User-Agent", async () => {
    const store = makeStore();
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/collect",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
      },
      payload: { schemaVersion: "1.0", events: [sessionStart()] },
    });
    expect(res.statusCode).toBe(200);
    const inserted = store.inserted[0]! as AnyEvent & { device?: { browser?: string; os?: string } };
    expect(inserted.device?.browser).toBe("Safari");
    expect(inserted.device?.os).toBe("macOS");
    await app.close();
  });

  it("rejects a batch for an unknown project with 401", async () => {
    const store = makeStore({ projectExists: async () => false });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/collect",
      payload: { schemaVersion: "1.0", events: [sessionStart()] },
    });
    expect(res.statusCode).toBe(401);
    expect(store.inserted).toHaveLength(0);
    await app.close();
  });

  it("rejects a batch that mixes project ids with 400", async () => {
    const store = makeStore();
    const app = await buildApp({ store, config });
    const other = { ...sessionStart(), projectId: "p2" } as AnyEvent;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/collect",
      payload: { schemaVersion: "1.0", events: [sessionStart(), other] },
    });
    expect(res.statusCode).toBe(400);
    expect(store.inserted).toHaveLength(0);
    await app.close();
  });

  it("rejects an empty batch with 400", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/collect",
      payload: { schemaVersion: "1.0", events: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("requires an API key for query routes", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({ method: "GET", url: "/api/v1/sessions" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns sessions for a valid API key", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    await app.close();
  });

  it("forbids an ingest-only key from reading the query API", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { "x-api-key": "ingest-key" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns the world-space heatmap for a valid API key", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/world?cellSize=0.25",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ vx: 1, vy: 0, vz: -2, count: 7 }]);
    await app.close();
  });

  it("forwards a scene filter to the world heatmap store call", async () => {
    let received: unknown;
    const store = makeStore({
      worldHeatmap: async (_projectId, opts) => {
        received = opts;
        return [{ vx: 1, vy: 0, vz: -2, count: 7 }];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/world?scene=lobby",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby" });
    await app.close();
  });

  it("returns the funnel for a valid API key (#78)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const steps = JSON.stringify([{ type: "camera_sample" }, { type: "pointer_click" }]);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/funnel?steps=${encodeURIComponent(steps)}`,
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { step: 0, sessions: 10 },
      { step: 1, sessions: 4 },
    ]);
    await app.close();
  });

  it("forwards parsed funnel steps + filters to the store call (#78)", async () => {
    let received: unknown;
    const store = makeStore({
      funnel: async (_projectId, opts) => {
        received = opts;
        return [{ step: 0, sessions: 1 }];
      },
    });
    const app = await buildApp({ store, config });
    const steps = JSON.stringify([
      { type: "camera_gesture", name: "orbit" },
      { type: "mesh_interaction", name: "pick", mesh: "box" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/funnel?scene=lobby&cameraMode=viewer&steps=${encodeURIComponent(steps)}`,
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({
      scene: "lobby",
      cameraType: "arc-rotate",
      steps: [
        { type: "camera_gesture", name: "orbit" },
        { type: "mesh_interaction", name: "pick", mesh: "box" },
      ],
    });
    await app.close();
  });

  it("rejects funnel steps that are not valid JSON with 400 (#78)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/funnel?steps=not-json",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a funnel with fewer than two steps with 400 (#78)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const steps = JSON.stringify([{ type: "camera_sample" }]);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/funnel?steps=${encodeURIComponent(steps)}`,
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns the world-space gaze heatmap for a valid API key", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/gaze?cellSize=0.5",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ vx: 3, vy: 1, vz: -1, count: 6 }]);
    await app.close();
  });

  it("forwards a scene filter to the gaze heatmap store call", async () => {
    let received: unknown;
    const store = makeStore({
      gazeHeatmap: async (_projectId, opts) => {
        received = opts;
        return [{ vx: 3, vy: 1, vz: -1, count: 6 }];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/gaze?scene=lobby",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby" });
    await app.close();
  });

  it("returns world heatmap totals with the effective cellSize (ADR 0040 §3)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/world/stats?cellSize=0.25",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cellSize: 0.25, cells: 12, hits: 34 });
    await app.close();
  });

  it("returns gaze heatmap totals (ADR 0040 §3)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/gaze/stats?cellSize=0.5",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cellSize: 0.5, cells: 5, hits: 9 });
    await app.close();
  });

  it("parses a region filter and forwards it as an AABB to the world heatmap (ADR 0040 §4)", async () => {
    let received: { region?: unknown } | undefined;
    const store = makeStore({
      worldHeatmap: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/world?region=0,0,0,10,5,10",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received?.region).toEqual([0, 0, 0, 10, 5, 10]);
    await app.close();
  });

  it("rejects a malformed region filter with 400 (ADR 0040 §4)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/world?region=0,0,0,10",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("derives the world heatmap cellSize from scene bounds when omitted (ADR 0040 §1)", async () => {
    let received: { cellSize?: number } | undefined;
    const store = makeStore({
      getSceneRepresentation: async () =>
        ({ bounds: [0, 0, 0, 128, 4, 8] }) as unknown as Awaited<
          ReturnType<CollectorStore["getSceneRepresentation"]>
        >,
      worldHeatmap: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/world?scene=lobby",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    // Longest axis is 128; 128 / 64 = 2 world units per voxel.
    expect(received?.cellSize).toBe(2);
    await app.close();
  });

  it("derives the world heatmap cellSize from a region when omitted (ADR 0040 §1/§4)", async () => {
    let received: { cellSize?: number } | undefined;
    const store = makeStore({
      worldHeatmap: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/world?region=0,0,0,64,2,2",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    // The region's longest axis is 64; 64 / 64 = 1 world unit per voxel.
    expect(received?.cellSize).toBe(1);
    await app.close();
  });

  it("returns view-gated click rays for a valid API key", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/click-rays?cellSize=0.5",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        cam_vx: 0,
        cam_vy: 1,
        cam_vz: 0,
        origin_x: 0.1,
        origin_y: 1.6,
        origin_z: 0.2,
        hit_vx: 2,
        hit_vy: 0,
        hit_vz: -4,
        hit_x: 1.05,
        hit_y: 0.2,
        hit_z: -2.1,
        mesh: "Cube",
        count: 4,
      },
    ]);
    await app.close();
  });

  it("forwards scene/source/session filters to the click-rays store call", async () => {
    let received: unknown;
    const store = makeStore({
      clickGazeRays: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/click-rays?scene=lobby&source=hand&session=s1",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby", source: "hand", session: "s1" });
    await app.close();
  });

  it("requires an API key for the click-rays route", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({ method: "GET", url: "/api/v1/heatmaps/click-rays" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns aggregate flow links for a valid API key", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/flow?bins=24",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ azimuth_bin: 8, elevation_bin: 15, mesh: "Cube", count: 11 }]);
    await app.close();
  });

  it("forwards scene/session/bins filters to the flow store call", async () => {
    let received: unknown;
    const store = makeStore({
      flowHeatmap: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/flow?scene=lobby&session=s1&bins=30",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby", session: "s1", bins: 30 });
    await app.close();
  });

  it("forwards position-aware flow params to the store (§7.8)", async () => {
    let received: Record<string, unknown> | undefined;
    const store = makeStore({
      flowHeatmap: async (_projectId, opts) => {
        received = opts as Record<string, unknown>;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/flow?cellSize=2&groupByOrigin=true&originVoxel=3,0,-4&cameraMode=first-person",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({
      cellSize: 2,
      groupByOrigin: true,
      originVoxel: [3, 0, -4],
      cameraType: "free",
    });
    await app.close();
  });

  it("returns object dwell rankings for a valid API key (#37)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/meshes/dwell",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { mesh: "Cube", visible_ms: 5000, centered_ms: 2000, max_screen_fraction: 0.51, samples: 2 },
    ]);
    await app.close();
  });

  it("forwards scene/session filters to the mesh-dwell store call (#37)", async () => {
    let received: unknown;
    const store = makeStore({
      meshDwell: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/meshes/dwell?scene=lobby&session=s1",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby", session: "s1" });
    await app.close();
  });

  it("returns dead-click counts for a valid API key (#46)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/clicks/dead",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ total_clicks: 10, dead_clicks: 3 }]);
    await app.close();
  });

  it("forwards scene/session/source filters to the dead-clicks store call (#46)", async () => {
    let received: unknown;
    const store = makeStore({
      deadClicks: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/clicks/dead?scene=lobby&session=s1&source=mouse",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby", session: "s1", source: "mouse" });
    await app.close();
  });

  it("returns rage-click clusters for a valid API key (#47)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/clicks/rage",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { session_id: "s1", mesh: "Button", bucket: 1718532000000, clicks: 4 },
    ]);
    await app.close();
  });

  it("forwards burst window/threshold to the rage-clicks store call (#47)", async () => {
    let received: unknown;
    const store = makeStore({
      rageClicks: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/clicks/rage?scene=lobby&session=s1&source=mouse&interval=3&minRepeats=4",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({
      scene: "lobby",
      session: "s1",
      source: "mouse",
      interval: 3,
      minRepeats: 4,
    });
    await app.close();
  });

  it("returns hover-dwell hesitation rows for a valid API key (#48)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/hover/dwell",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { mesh: "Button", dwell_ms: 4200, max_dwell_ms: 1800, episodes: 5 },
    ]);
    await app.close();
  });

  it("forwards scene/session/source filters to the hover-dwell store call (#48)", async () => {
    let received: unknown;
    const store = makeStore({
      hoverDwell: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/hover/dwell?scene=lobby&session=s1&source=mouse",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby", session: "s1", source: "mouse" });
    await app.close();
  });

  it("returns per-phase compile-stall rows for a valid API key (#42)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/perf/compile-stalls",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { phase: "shader", stalls: 7, total_ms: 210, avg_ms: 30, max_ms: 64 },
    ]);
    await app.close();
  });

  it("forwards scene/session filters to the compile-stalls store call (#42)", async () => {
    let received: unknown;
    const store = makeStore({
      compileStalls: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/perf/compile-stalls?scene=lobby&session=s1",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby", session: "s1" });
    await app.close();
  });

  it("returns a resource-footprint summary for a valid API key (#44)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/perf/resources",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        samples: 4,
        avg_js_heap_bytes: 50_000_000,
        max_js_heap_bytes: 80_000_000,
        avg_triangles: 150_000,
        max_triangles: 240_000,
        avg_vertices: 110_000,
        max_vertices: 130_000,
        avg_texture_bytes: 2_000_000,
        max_texture_bytes: 3_000_000,
        avg_geometry_bytes: 600_000,
        max_geometry_bytes: 700_000,
      },
    ]);
    await app.close();
  });

  it("forwards the session filter to the resource-summary store call (#44)", async () => {
    let received: unknown;
    const store = makeStore({
      resourceSummary: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/perf/resources?session=s1",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ session: "s1" });
    await app.close();
  });

  it("returns per-session FPS distribution for a valid API key (#81)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/perf/distribution",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { sessions: 3, samples: 120, p05_fps: 28, p50_fps: 58, p95_fps: 60 },
    ]);
    await app.close();
  });

  it("forwards the bucket width to the fps-histogram store call (#81)", async () => {
    let received: unknown;
    const store = makeStore({
      fpsHistogram: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/perf/fps-histogram?bucket=15&scene=lobby",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ bucket: 15, scene: "lobby" });
    await app.close();
  });

  it("returns frame-time percentiles and jank rate for a valid API key (#81)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const frameTime = await app.inject({
      method: "GET",
      url: "/api/v1/perf/frame-time",
      headers: { "x-api-key": "valid-key" },
    });
    expect(frameTime.statusCode).toBe(200);
    expect(frameTime.json()).toEqual([{ sessions: 3, samples: 120, p50_ms: 16, p95_ms: 33 }]);

    const jank = await app.inject({
      method: "GET",
      url: "/api/v1/perf/jank",
      headers: { "x-api-key": "valid-key" },
    });
    expect(jank.statusCode).toBe(200);
    expect(jank.json()).toEqual([
      { sessions: 3, total_long_frames: 14, median_rate: 2, worst_decile_rate: 5 },
    ]);
    await app.close();
  });

  it("returns FPS by device and by scene for a valid API key (#82)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const byDevice = await app.inject({
      method: "GET",
      url: "/api/v1/perf/by-device",
      headers: { "x-api-key": "valid-key" },
    });
    expect(byDevice.statusCode).toBe(200);
    expect(byDevice.json()).toEqual([
      {
        engine: "webgpu",
        is_mobile: "false",
        renderer: "M3",
        sessions: 2,
        samples: 80,
        p50_fps: 60,
      },
    ]);

    const byScene = await app.inject({
      method: "GET",
      url: "/api/v1/perf/by-scene",
      headers: { "x-api-key": "valid-key" },
    });
    expect(byScene.statusCode).toBe(200);
    expect(byScene.json()).toEqual([{ scene_id: "lobby", sessions: 2, samples: 80, p50_fps: 58 }]);
    await app.close();
  });

  it("returns resource percentiles and stability counts for a valid API key (#83)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const resources = await app.inject({
      method: "GET",
      url: "/api/v1/perf/resource-percentiles",
      headers: { "x-api-key": "valid-key" },
    });
    expect(resources.statusCode).toBe(200);
    expect(resources.json()).toEqual([
      {
        sessions: 3,
        samples: 60,
        p50_js_heap_bytes: 50_000_000,
        p95_js_heap_bytes: 80_000_000,
        p50_texture_bytes: 2_000_000,
        p95_texture_bytes: 3_000_000,
        p50_triangles: 150_000,
        p95_triangles: 240_000,
      },
    ]);

    const stability = await app.inject({
      method: "GET",
      url: "/api/v1/perf/stability?scene=lobby&session=s1",
      headers: { "x-api-key": "valid-key" },
    });
    expect(stability.statusCode).toBe(200);
    expect(stability.json()).toEqual([{ context_losses: 1, compile_stalls: 2, incidents: 3 }]);
    await app.close();
  });

  it("returns capability-change transitions for a valid API key (#49)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { kind: "graphics-backend", from: "webgpu", to: "webgl2", changes: 12 },
    ]);
    await app.close();
  });

  it("forwards scene/session filters to the capability-changes store call (#49)", async () => {
    let received: unknown;
    const store = makeStore({
      capabilityChanges: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities?scene=lobby&session=s1",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby", session: "s1" });
    await app.close();
  });

  it("returns camera-gesture navigation breakdown for a valid API key (ADR 0025)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/camera-gestures",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { kind: "orbit", gestures: 9, total_ms: 4500, avg_ms: 500, max_ms: 1200 },
    ]);
    await app.close();
  });

  it("forwards scene/source/session filters to the camera-gestures store call (ADR 0025)", async () => {
    let received: unknown;
    const store = makeStore({
      cameraGestures: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/camera-gestures?scene=lobby&source=mouse&session=s1",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby", source: "mouse", session: "s1" });
    await app.close();
  });

  it("returns the XR motion-sickness proxy for a valid API key (#50)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/xr/rotation",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        session_id: "s1",
        samples: 8,
        avg_turn_rad: 0.3,
        max_turn_rad: 1.2,
        total_turn_rad: 2.4,
        rapid_segments: 2,
      },
    ]);
    await app.close();
  });

  it("forwards the rapidTurn threshold to the XR rotation store call (#50)", async () => {
    let received: unknown;
    const store = makeStore({
      xrRotationRate: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/xr/rotation?rapidTurn=0.4&scene=lobby",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ rapidTurn: 0.4, scene: "lobby" });
    await app.close();
  });

  it("splits XR input usage by source for a valid API key (#50)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/xr/sources",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { source: "hand", interactions: 9, sessions: 2 },
      { source: "xr-controller", interactions: 4, sessions: 1 },
    ]);
    await app.close();
  });

  it("returns XR session abandonment counts for a valid API key (#50)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/xr/abandonment?scene=lobby&session=s1",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        session_id: "s1",
        events: 30,
        xr_interactions: 6,
        started_at: "2024-06-16 10:00:00.000",
        ended_at: "2024-06-16 10:00:08.000",
      },
    ]);
    await app.close();
  });

  it("returns the input-source breakdown for a valid API key (ADR 0011)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/interactions/sources",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { event_type: "pointer_click", source: "mouse", count: 18, sessions: 3 },
      { event_type: "mesh_interaction", source: "xr-controller", count: 5, sessions: 2 },
    ]);
    await app.close();
  });

  it("forwards scene/source/session filters to the interactions-by-source store call (ADR 0011)", async () => {
    let received: unknown;
    const store = makeStore({
      interactionsBySource: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/interactions/sources?scene=lobby&source=hand&session=s1",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ scene: "lobby", source: "hand", session: "s1" });
    await app.close();
  });

  it("rejects a scene filter that breaks the low-cardinality charset", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/world?scene=bad%20scene",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("forwards an input-source filter to the pointer heatmap store call (ADR 0011)", async () => {
    let received: unknown;
    const store = makeStore({
      pointerHeatmap: async (_projectId, opts) => {
        received = opts;
        return [{ gx: 1, gy: 2, count: 5 }];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/pointer?source=hand",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ source: "hand" });
    await app.close();
  });

  it("rejects an input-source filter outside the vocabulary (ADR 0011)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/heatmaps/pointer?source=telepathy",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns distinct scenes for a valid API key (ADR 0010)", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/scenes",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { scene_id: "lobby", events: 42, last_seen: "2024-06-16 10:05:00.000" },
    ]);
    await app.close();
  });

  it("forwards range + scene + type filters to the timeseries store call", async () => {
    let received: unknown;
    const store = makeStore({
      timeseries: async (_projectId, opts) => {
        received = opts;
        return [{ bucket: 1718532000000, events: 12, avg_fps: 59.5 }];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/timeseries?interval=300&scene=lobby&type=pointer_click",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toMatchObject({ interval: 300, scene: "lobby", type: "pointer_click" });
    await app.close();
  });

  it("returns per-event-type counts for a valid API key", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/event-counts",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ event_type: "pointer_move", count: 30 }]);
    await app.close();
  });

  it("forwards cell size + scene + session to the coverage store call (#38)", async () => {
    let received: unknown;
    const store = makeStore({
      sceneCoverage: async (_projectId, opts) => {
        received = opts;
        return [{ vx: 0, vy: 0, vz: 0, count: 3 }];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/coverage?cellSize=2&scene=lobby&session=s1",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ vx: 0, vy: 0, vz: 0, count: 3 }]);
    expect(received).toMatchObject({ cellSize: 2, scene: "lobby", session: "s1" });
    await app.close();
  });

  it("maps center components into a tuple for the camera-distance store call (#39)", async () => {
    let received: { center?: readonly number[] } | undefined;
    const store = makeStore({
      cameraDistance: async (_projectId, opts) => {
        received = opts;
        return [{ bucket: 2, count: 4 }];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/camera/distance?centerX=1&centerY=2&centerZ=3&bucketSize=0.5",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ bucket: 2, count: 4 }]);
    expect(received).toMatchObject({ center: [1, 2, 3], bucketSize: 0.5 });
    await app.close();
  });

  it("leaves the camera-distance center undefined when no component is given (#39)", async () => {
    let received: { center?: readonly number[] } | undefined;
    const store = makeStore({
      cameraDistance: async (_projectId, opts) => {
        received = opts;
        return [];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/camera/distance",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(received?.center).toBeUndefined();
    await app.close();
  });

  it("forwards the move threshold to the navigation store call (#40)", async () => {
    let received: unknown;
    const store = makeStore({
      navigationStats: async (_projectId, opts) => {
        received = opts;
        return [
          {
            session_id: "s1",
            segments: 5,
            total_distance: 12.5,
            active_segments: 3,
            active_distance: 11,
          },
        ];
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/navigation?moveThreshold=0.1&scene=lobby",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        session_id: "s1",
        segments: 5,
        total_distance: 12.5,
        active_segments: 3,
        active_distance: 11,
      },
    ]);
    expect(received).toMatchObject({ moveThreshold: 0.1, scene: "lobby" });
    await app.close();
  });

  it("gates the replay timeline behind raw-session retention", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/s1/events",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("serves the replay timeline when retention is enabled", async () => {
    const app = await buildApp({
      store: makeStore(),
      config: { ...config, enableRawSessionRetention: true },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/s1/events",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("streams the replay timeline as NDJSON when negotiated", async () => {
    const events: AnyEvent[] = [
      {
        type: "camera_sample",
        projectId: "p1",
        sessionId: "s1",
        ts: 100,
        sdkVersion: "0.1.0",
        position: [0, 0, 0],
        direction: [0, 0, 1],
      } as AnyEvent,
      {
        type: "camera_sample",
        projectId: "p1",
        sessionId: "s1",
        ts: 200,
        sdkVersion: "0.1.0",
        position: [0, 0, 0],
        direction: [0, 0, 1],
      } as AnyEvent,
    ];
    const app = await buildApp({
      store: makeStore({
        streamSessionEvents: async function* () {
          for (const e of events) yield e;
        },
      }),
      config: { ...config, enableRawSessionRetention: true },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/s1/events",
      headers: { "x-api-key": "valid-key", accept: "application/x-ndjson" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const lines = res.body.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l).ts)).toEqual([100, 200]);
    await app.close();
  });

  it("gates NDJSON streaming behind raw-session retention too", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/s1/events?format=ndjson",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("serves session metadata without the retention gate", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/s1/meta",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sessionId: "s1",
      scene: { cameraType: "arc-rotate", meshCount: 6 },
      user: { id: "anon_abc" },
    });
    await app.close();
  });

  it("returns 404 for unknown session metadata", async () => {
    const app = await buildApp({
      store: makeStore({ getSessionMeta: async () => null }),
      config,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/nope/meta",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("scene registry routes", () => {
  const proxy = {
    version: 1 as const,
    sceneId: "lobby",
    kind: "aabb" as const,
    bounds: [-2, 0, -2, 2, 3, 2] as [number, number, number, number, number, number],
    upAxis: "y" as const,
    unitScale: 1,
    meshes: [
      {
        name: "floor",
        aabb: [-2, 0, -2, 2, 0.1, 2] as [number, number, number, number, number, number],
      },
    ],
    meshCount: 1,
    contentHash: "abc123",
    capturedAt: 1_750_000_000_000,
    sdkVersion: "0.1.0",
  };

  it("registers a scene proxy via PUT and echoes the stored representation", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/scenes/lobby/representation",
      headers: { "x-api-key": "valid-key" },
      payload: { proxy, label: "Main Lobby" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sceneId: "lobby", kind: "proxy", label: "Main Lobby" });
    await app.close();
  });

  it("allows the PUT method in the CORS preflight (proxy registration from the browser)", async () => {
    // @fastify/cors defaults `methods` to GET,HEAD,POST; without an explicit PUT
    // the browser preflight for proxy registration fails with "Failed to fetch".
    const app = await buildApp({
      store: makeStore(),
      config: { ...config, corsOrigins: ["http://localhost:5173"] },
    });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/scenes/lobby/representation",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "x-api-key,content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(String(res.headers["access-control-allow-methods"])).toContain("PUT");
    await app.close();
  });

  it("allows credentials in the ingestion CORS preflight (sendBeacon sends credentialed)", async () => {
    // The SDK ingests via `navigator.sendBeacon`, which always runs in
    // credentials mode `include`. The `application/json` body forces a preflight,
    // and the browser drops the beacon unless the response echoes
    // `Access-Control-Allow-Credentials: true` — which would break cross-origin
    // ingestion (app and collector on different origins).
    const app = await buildApp({
      store: makeStore(),
      config: { ...config, corsOrigins: ["http://localhost:5173"] },
    });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/collect",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    await app.close();
  });

  it("rejects a PUT whose path scene id mismatches the proxy", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/scenes/other/representation",
      headers: { "x-api-key": "valid-key" },
      payload: { proxy },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("requires authentication to register a proxy", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/scenes/lobby/representation",
      payload: { proxy },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 404 for an unregistered scene representation", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/scenes/lobby/representation",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("lists scene representations", async () => {
    const app = await buildApp({
      store: makeStore({
        listSceneRepresentations: async () => [
          {
            sceneId: "lobby",
            label: "Main Lobby",
            kind: "proxy",
            bounds: [-2, 0, -2, 2, 3, 2],
            contentHash: "abc123",
            capturedAt: new Date(0),
            updatedAt: new Date(0),
          },
        ],
      }),
      config,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/scene-representations",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0]).toMatchObject({ sceneId: "lobby", kind: "proxy" });
    await app.close();
  });
});
