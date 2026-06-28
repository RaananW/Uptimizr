import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent, SceneProxy } from "@uptimizr/schema";
import {
  buildCameraDirectionHeatmap,
  buildCameraDistance,
  buildClickGazeRay,
  buildDistinctScenes,
  buildEventsDaily,
  buildEventTypeCounts,
  buildFlowHeatmap,
  buildListSessions,
  buildMeshDwell,
  buildMeshInteractionKinds,
  buildDeadClicks,
  buildRageClicks,
  buildHoverDwell,
  buildCompileStalls,
  buildResourceSummary,
  buildResourcePercentiles,
  buildStabilityCounts,
  buildGraphicsDiagnosticCounts,
  buildCapabilityChanges,
  buildNavigationStats,
  buildXrRotationRate,
  buildXrSourceUsage,
  buildXrAbandonment,
  buildPerfDaily,
  buildPerfSummary,
  buildPointerHeatmap,
  buildSceneCoverage,
  buildTimeseries,
  buildTopMeshes,
  buildTopMeshesBySource,
  buildTopMeshesTrend,
  buildTopInputActions,
  buildWorldHeatmap,
  duckdbDialect,
} from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { runDuckdbQuery } from "../duckdb/queries.js";
import {
  getSessionEvents,
  getSessionMeta,
  insertEvents,
  streamSessionEvents,
} from "../duckdb/events.js";
import { createApiKey, createProject, resolveApiKey } from "../duckdb/projects.js";
import {
  getSceneRepresentation,
  listSceneRepresentations,
  upsertSceneProxy,
} from "../duckdb/sceneRegistry.js";

const PID = "p1";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 60_000 };

function base(type: string, ts: number, extra: Record<string, unknown> = {}): AnyEvent {
  return {
    type,
    projectId: PID,
    sessionId: "s1",
    ts,
    sdkVersion: "0.1.0",
    sceneId: "lobby",
    ...extra,
  } as AnyEvent;
}

const EVENTS: AnyEvent[] = [
  base("session_start", T0, {
    scene: { cameraType: "arc-rotate", cameraName: "cam", meshCount: 3 },
    user: { id: "anon-1" },
    device: { engine: "webgpu" },
  }),
  base("camera_sample", T0 + 1_000, { position: [1, 2, 3], direction: [0, 0, 1] }),
  base("pointer_move", T0 + 2_000, {
    screen: [0.5, 0.5],
    hitPoint: [1, 1, 1],
    hitMesh: "box",
    source: "mouse",
  }),
  base("pointer_click", T0 + 3_000, {
    screen: [0.4, 0.6],
    hitPoint: [2, 2, 2],
    hitMesh: "box",
    button: 0,
    source: "mouse",
  }),
  base("frame_perf", T0 + 4_000, { fps: 60 }),
];

describe("duckdb store", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("issues and resolves API keys (hashed, never plaintext)", async () => {
    const project = await createProject(db, "Demo");
    const { key, record } = await createApiKey(db, project.id);
    expect(key).toMatch(/^utk_/);
    // Keys default to the `query` read capability.
    expect(record.capability).toBe("query");
    expect(await resolveApiKey(db, key)).toEqual({
      projectId: project.id,
      capability: "query",
    });
    expect(await resolveApiKey(db, "utk_unknown")).toBeNull();
  });

  it("issues an ingest-capability key when requested", async () => {
    const project = await createProject(db, "Demo");
    const { key } = await createApiKey(db, project.id, "ingest");
    expect(await resolveApiKey(db, key)).toEqual({
      projectId: project.id,
      capability: "ingest",
    });
  });

  it("ingests events and lists sessions", async () => {
    await insertEvents(db, EVENTS);
    const sessions = await runDuckdbQuery(db, buildListSessions(PID, RANGE, duckdbDialect));
    expect(sessions).toEqual([
      expect.objectContaining({ session_id: "s1", visitor_id: "", events: 5 }),
    ]);
  });

  it("computes the pointer (2D) heatmap", async () => {
    await insertEvents(db, EVENTS);
    const bins = await runDuckdbQuery<{ count: number }>(
      db,
      buildPointerHeatmap(PID, { ...RANGE, bins: 10 }, duckdbDialect),
    );
    expect(bins.reduce((n, b) => n + Number(b.count), 0)).toBe(2);
  });

  it("computes the world (3D) heatmap from hit points", async () => {
    await insertEvents(db, EVENTS);
    const voxels = await runDuckdbQuery<{ count: number }>(
      db,
      buildWorldHeatmap(PID, { ...RANGE, cellSize: 1 }, duckdbDialect),
    );
    expect(voxels.reduce((n, v) => n + Number(v.count), 0)).toBe(2);
  });

  it("computes the camera-direction heatmap", async () => {
    await insertEvents(db, EVENTS);
    const dirs = await runDuckdbQuery<{ count: number }>(
      db,
      buildCameraDirectionHeatmap(PID, { ...RANGE, bins: 8 }, duckdbDialect),
    );
    expect(dirs.reduce((n, d) => n + Number(d.count), 0)).toBe(1);
  });

  it("correlates clicks with gaze (ASOF join)", async () => {
    await insertEvents(db, EVENTS);
    const rays = await runDuckdbQuery<{ count: number }>(
      db,
      buildClickGazeRay(PID, { ...RANGE, cellSize: 1 }, duckdbDialect),
    );
    expect(rays.reduce((n, r) => n + Number(r.count), 0)).toBe(1);
  });

  it("uses the click ray origin for pose-enabled sources, ignoring the camera", async () => {
    // The camera sits far away; an XR-controller click carries its own pointing
    // ray, so the ray origin — not the headset/camera — must drive the ray.
    const poseEvents: AnyEvent[] = [
      base("camera_sample", T0 + 1_000, { position: [99, 99, 99], direction: [0, 0, 1] }),
      base("pointer_click", T0 + 2_000, {
        screen: [0.5, 0.5],
        hitPoint: [3, 3, 3],
        hitMesh: "panel",
        button: 0,
        source: "xr-controller",
        handedness: "right",
        ray: { origin: [1.5, 1.6, 0.5], direction: [0, 0, -1] },
      }),
    ];
    await insertEvents(db, poseEvents);
    const rays = await runDuckdbQuery<{
      origin_x: number;
      origin_y: number;
      origin_z: number;
      mesh: string;
      count: number;
    }>(db, buildClickGazeRay(PID, { ...RANGE, cellSize: 1 }, duckdbDialect));
    expect(rays).toHaveLength(1);
    expect(Number(rays[0].origin_x)).toBeCloseTo(1.5);
    expect(Number(rays[0].origin_y)).toBeCloseTo(1.6);
    expect(Number(rays[0].origin_z)).toBeCloseTo(0.5);
    expect(rays[0].mesh).toBe("panel");
  });

  it("keeps a pose click even when the session has no camera sample", async () => {
    const poseEvents: AnyEvent[] = [
      base("pointer_click", T0 + 2_000, {
        screen: [0.5, 0.5],
        hitPoint: [3, 3, 3],
        hitMesh: "panel",
        button: 0,
        source: "gaze",
        ray: { origin: [0, 1.6, 0], direction: [0, 0, -1] },
      }),
    ];
    await insertEvents(db, poseEvents);
    const rays = await runDuckdbQuery<{ count: number; origin_y: number }>(
      db,
      buildClickGazeRay(PID, { ...RANGE, cellSize: 1 }, duckdbDialect),
    );
    expect(rays.reduce((n, r) => n + Number(r.count), 0)).toBe(1);
    expect(Number(rays[0].origin_y)).toBeCloseTo(1.6);
  });

  it("drops a flat click with no camera sample to fall back to", async () => {
    const flatEvents: AnyEvent[] = [
      base("pointer_click", T0 + 2_000, {
        screen: [0.5, 0.5],
        hitPoint: [3, 3, 3],
        hitMesh: "panel",
        button: 0,
        source: "mouse",
      }),
    ];
    await insertEvents(db, flatEvents);
    const rays = await runDuckdbQuery<{ count: number }>(
      db,
      buildClickGazeRay(PID, { ...RANGE, cellSize: 1 }, duckdbDialect),
    );
    expect(rays).toHaveLength(0);
  });

  it("reconstructs the near-plane origin for a flat pointer click (#22)", async () => {
    // The camera carries projection intrinsics, so a mouse click unprojects its
    // off-centre `screen` onto the near plane instead of collapsing to the camera
    // point. Expected origin computed from the same unproject the SQL applies.
    const position: [number, number, number] = [0, 0, 0];
    const direction: [number, number, number] = [2, 1, 2];
    const screen: [number, number] = [0.15, 0.15];
    const fov = Math.PI / 2;
    const aspect = 2;
    const near = 0.1;
    const [dx, dy, dz] = direction;
    const dlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const hlen = Math.sqrt(dx * dx + dz * dz);
    const offR = (2 * screen[0] - 1) * near * Math.tan(fov / 2) * aspect;
    const offU = (1 - 2 * screen[1]) * near * Math.tan(fov / 2);
    const expected = [
      position[0] + (dx * near) / dlen + (dz / hlen) * offR + (-(dx * dy) / (dlen * hlen)) * offU,
      position[1] + (dy * near) / dlen + (hlen / dlen) * offU,
      position[2] + (dz * near) / dlen + (-dx / hlen) * offR + (-(dy * dz) / (dlen * hlen)) * offU,
    ];
    const flatEvents: AnyEvent[] = [
      base("camera_sample", T0 + 1_000, { position, direction, fov, aspect, near }),
      base("pointer_click", T0 + 2_000, {
        screen,
        hitPoint: [5, 5, 5],
        hitMesh: "box",
        button: 0,
        source: "mouse",
      }),
    ];
    await insertEvents(db, flatEvents);
    const rays = await runDuckdbQuery<{
      origin_x: number;
      origin_y: number;
      origin_z: number;
      mesh: string;
    }>(db, buildClickGazeRay(PID, { ...RANGE, cellSize: 1 }, duckdbDialect));
    expect(rays).toHaveLength(1);
    expect(Number(rays[0].origin_x)).toBeCloseTo(expected[0], 9);
    expect(Number(rays[0].origin_y)).toBeCloseTo(expected[1], 9);
    expect(Number(rays[0].origin_z)).toBeCloseTo(expected[2], 9);
    // The reconstructed origin must differ from the raw camera point.
    expect(Number(rays[0].origin_x)).not.toBeCloseTo(0, 3);
  });

  it("falls back to the camera position when intrinsics are missing (#22)", async () => {
    // No fov/aspect/near on the camera sample → the flat click keeps the legacy
    // camera-position origin.
    const flatEvents: AnyEvent[] = [
      base("camera_sample", T0 + 1_000, { position: [5, 6, 7], direction: [2, 1, 2] }),
      base("pointer_click", T0 + 2_000, {
        screen: [0.3, 0.3],
        hitPoint: [9, 9, 9],
        hitMesh: "box",
        button: 0,
        source: "mouse",
      }),
    ];
    await insertEvents(db, flatEvents);
    const rays = await runDuckdbQuery<{
      origin_x: number;
      origin_y: number;
      origin_z: number;
    }>(db, buildClickGazeRay(PID, { ...RANGE, cellSize: 1 }, duckdbDialect));
    expect(rays).toHaveLength(1);
    expect(Number(rays[0].origin_x)).toBeCloseTo(5);
    expect(Number(rays[0].origin_y)).toBeCloseTo(6);
    expect(Number(rays[0].origin_z)).toBeCloseTo(7);
  });

  it("falls back to the camera position for a degenerate look-up/down view (#22)", async () => {
    // Looking straight up makes the near-plane basis undefined (no roll-free right
    // vector), so reconstruction is skipped in favour of the camera position.
    const flatEvents: AnyEvent[] = [
      base("camera_sample", T0 + 1_000, {
        position: [1, 2, 3],
        direction: [0, 1, 0],
        fov: Math.PI / 2,
        aspect: 1,
        near: 0.1,
      }),
      base("pointer_click", T0 + 2_000, {
        screen: [0.2, 0.8],
        hitPoint: [9, 9, 9],
        hitMesh: "box",
        button: 0,
        source: "mouse",
      }),
    ];
    await insertEvents(db, flatEvents);
    const rays = await runDuckdbQuery<{
      origin_x: number;
      origin_y: number;
      origin_z: number;
    }>(db, buildClickGazeRay(PID, { ...RANGE, cellSize: 1 }, duckdbDialect));
    expect(rays).toHaveLength(1);
    expect(Number(rays[0].origin_x)).toBeCloseTo(1);
    expect(Number(rays[0].origin_y)).toBeCloseTo(2);
    expect(Number(rays[0].origin_z)).toBeCloseTo(3);
  });

  it("computes the flow heatmap", async () => {
    await insertEvents(db, EVENTS);
    const links = await runDuckdbQuery(db, buildFlowHeatmap(PID, RANGE, duckdbDialect));
    expect(Array.isArray(links)).toBe(true);
  });

  it("restores the standpoint voxel in position-aware flow (§7.8)", async () => {
    await insertEvents(db, EVENTS);
    // The only click ("box") ASOF-joins the camera sample at position [1,2,3];
    // at cellSize 1 that standpoint is voxel (1,2,3) with the same world centroid.
    const links = await runDuckdbQuery<{
      origin_vx: number;
      origin_vy: number;
      origin_vz: number;
      origin_x: number;
      origin_y: number;
      origin_z: number;
      mesh: string;
    }>(
      db,
      buildFlowHeatmap(
        PID,
        { ...RANGE, bins: 24, cellSize: 1, groupByOrigin: true },
        duckdbDialect,
      ),
    );
    expect(links).toHaveLength(1);
    expect(links[0].mesh).toBe("box");
    expect(Number(links[0].origin_vx)).toBe(1);
    expect(Number(links[0].origin_vy)).toBe(2);
    expect(Number(links[0].origin_vz)).toBe(3);
    expect(Number(links[0].origin_x)).toBeCloseTo(1);
    expect(Number(links[0].origin_y)).toBeCloseTo(2);
    expect(Number(links[0].origin_z)).toBeCloseTo(3);
  });

  it("prefers the click ray origin for the standpoint (§7.8 / ADR 0011)", async () => {
    // The camera sits far away; an XR-controller click carries its own ray, so
    // the standpoint must be the ray origin, not the headset/camera position.
    const poseEvents: AnyEvent[] = [
      base("camera_sample", T0 + 1_000, { position: [99, 99, 99], direction: [0, 0, 1] }),
      base("pointer_click", T0 + 2_000, {
        screen: [0.5, 0.5],
        hitPoint: [3, 3, 3],
        hitMesh: "panel",
        button: 0,
        source: "xr-controller",
        handedness: "right",
        ray: { origin: [1.5, 1.6, 0.5], direction: [0, 0, -1] },
      }),
    ];
    await insertEvents(db, poseEvents);
    const links = await runDuckdbQuery<{
      origin_x: number;
      origin_y: number;
      origin_z: number;
      mesh: string;
    }>(
      db,
      buildFlowHeatmap(
        PID,
        { ...RANGE, bins: 24, cellSize: 1, groupByOrigin: true },
        duckdbDialect,
      ),
    );
    expect(links).toHaveLength(1);
    expect(links[0].mesh).toBe("panel");
    expect(Number(links[0].origin_x)).toBeCloseTo(1.5);
    expect(Number(links[0].origin_y)).toBeCloseTo(1.6);
    expect(Number(links[0].origin_z)).toBeCloseTo(0.5);
  });

  it("filters position-aware flow to a single standpoint voxel (§7.8)", async () => {
    // Two clicks from two standpoints: "a" from (0,0,0), "b" from (10,0,0).
    const twoStand: AnyEvent[] = [
      base("camera_sample", T0 + 1_000, { position: [0, 0, 0], direction: [0, 0, 1] }),
      base("pointer_click", T0 + 2_000, {
        screen: [0.5, 0.5],
        hitPoint: [1, 1, 1],
        hitMesh: "a",
        button: 0,
        source: "mouse",
      }),
      base("camera_sample", T0 + 3_000, { position: [10, 0, 0], direction: [0, 0, 1] }),
      base("pointer_click", T0 + 4_000, {
        screen: [0.5, 0.5],
        hitPoint: [2, 2, 2],
        hitMesh: "b",
        button: 0,
        source: "mouse",
      }),
    ];
    await insertEvents(db, twoStand);
    const links = await runDuckdbQuery<{ mesh: string; origin_vx: number }>(
      db,
      buildFlowHeatmap(
        PID,
        { ...RANGE, bins: 24, cellSize: 1, originVoxel: [10, 0, 0] },
        duckdbDialect,
      ),
    );
    expect(links).toHaveLength(1);
    expect(links[0].mesh).toBe("b");
    expect(Number(links[0].origin_vx)).toBe(10);
  });

  // Three camera_samples tracing an L-shaped path used by the derived metrics:
  // (0,0,0) -> (4,0,0) [4 units] -> (4,0,3) [3 units]. Total travel = 7.
  const NAV_EVENTS: AnyEvent[] = [
    base("camera_sample", T0 + 1_000, { position: [0, 0, 0], direction: [0, 0, 1] }),
    base("camera_sample", T0 + 2_000, { position: [4, 0, 0], direction: [0, 0, 1] }),
    base("camera_sample", T0 + 3_000, { position: [4, 0, 3], direction: [0, 0, 1] }),
  ];

  it("bins camera positions into coverage voxels", async () => {
    await insertEvents(db, NAV_EVENTS);
    const voxels = await runDuckdbQuery<{ vx: number; vy: number; vz: number; count: number }>(
      db,
      buildSceneCoverage(PID, { ...RANGE, cellSize: 1 }, duckdbDialect),
    );
    // Three distinct positions -> three occupied voxels, one visit each.
    expect(voxels).toHaveLength(3);
    expect(voxels.reduce((n, v) => n + Number(v.count), 0)).toBe(3);
  });

  it("histograms camera distance to a center", async () => {
    await insertEvents(db, NAV_EVENTS);
    // Center at the path elbow (4,0,0): distances 4, 0, 3 -> buckets 4, 0, 3.
    const buckets = await runDuckdbQuery<{ bucket: number; count: number }>(
      db,
      buildCameraDistance(PID, { ...RANGE, center: [4, 0, 0], bucketSize: 1 }, duckdbDialect),
    );
    const byBucket = new Map(buckets.map((b) => [Number(b.bucket), Number(b.count)]));
    expect(byBucket.get(0)).toBe(1);
    expect(byBucket.get(3)).toBe(1);
    expect(byBucket.get(4)).toBe(1);
  });

  it("accumulates per-session navigation travel distance", async () => {
    await insertEvents(db, NAV_EVENTS);
    const [stats] = await runDuckdbQuery<{
      session_id: string;
      segments: number;
      total_distance: number;
      active_segments: number;
    }>(db, buildNavigationStats(PID, RANGE, duckdbDialect));
    expect(stats).toMatchObject({ session_id: "s1", segments: 2, active_segments: 2 });
    expect(Number(stats!.total_distance)).toBeCloseTo(7, 5);
  });

  // An XR session: a head turn (0,0,1)->(1,0,0)->(1,0,0) plus controller/hand
  // interactions, used by the #50 comfort metrics.
  const XR_EVENTS: AnyEvent[] = [
    base("camera_sample", T0 + 1_000, { position: [0, 0, 0], direction: [0, 0, 1] }),
    base("camera_sample", T0 + 2_000, { position: [0, 0, 0], direction: [1, 0, 0] }),
    base("camera_sample", T0 + 3_000, { position: [0, 0, 0], direction: [1, 0, 0] }),
    base("pointer_click", T0 + 4_000, {
      screen: [0.5, 0.5],
      hitPoint: [1, 1, 1],
      hitMesh: "box",
      button: 0,
      source: "xr-controller",
      handedness: "right",
    }),
    base("pointer_click", T0 + 5_000, {
      screen: [0.5, 0.5],
      hitPoint: [1, 1, 1],
      hitMesh: "box",
      button: 0,
      source: "hand",
      handedness: "left",
    }),
    base("pointer_move", T0 + 6_000, {
      screen: [0.4, 0.4],
      hitPoint: [1, 1, 1],
      hitMesh: "box",
      source: "hand",
    }),
  ];

  it("derives the XR motion-sickness proxy from view-rotation rate (#50)", async () => {
    await insertEvents(db, XR_EVENTS);
    const [comfort] = await runDuckdbQuery<{
      session_id: string;
      samples: number;
      avg_turn_rad: number;
      max_turn_rad: number;
      total_turn_rad: number;
      rapid_segments: number;
    }>(db, buildXrRotationRate(PID, RANGE, duckdbDialect));
    // Two segments: a 90deg turn then no movement.
    expect(comfort).toMatchObject({ session_id: "s1", samples: 2, rapid_segments: 1 });
    expect(Number(comfort!.total_turn_rad)).toBeCloseTo(Math.PI / 2, 5);
    expect(Number(comfort!.max_turn_rad)).toBeCloseTo(Math.PI / 2, 5);
  });

  it("splits XR input usage by source (hand vs. controller) (#50)", async () => {
    await insertEvents(db, XR_EVENTS);
    const usage = await runDuckdbQuery<{
      source: string;
      interactions: number;
      sessions: number;
    }>(db, buildXrSourceUsage(PID, RANGE, duckdbDialect));
    const bySource = new Map(usage.map((u) => [u.source, u]));
    // Mouse-only sources are excluded; hand=click+move, controller=one click.
    expect(bySource.get("hand")).toMatchObject({ interactions: 2, sessions: 1 });
    expect(bySource.get("xr-controller")).toMatchObject({ interactions: 1, sessions: 1 });
    expect(bySource.has("mouse")).toBe(false);
  });

  it("reports XR session abandonment counts (#50)", async () => {
    await insertEvents(db, XR_EVENTS);
    const rows = await runDuckdbQuery<{
      session_id: string;
      events: number;
      xr_interactions: number;
    }>(db, buildXrAbandonment(PID, RANGE, duckdbDialect));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: "s1", events: 6, xr_interactions: 3 });
  });

  it("ranks top meshes", async () => {
    await insertEvents(db, EVENTS);
    const meshes = await runDuckdbQuery<{ mesh: string; count: number }>(
      db,
      buildTopMeshes(PID, RANGE, duckdbDialect),
    );
    expect(meshes).toEqual([expect.objectContaining({ mesh: "box", count: 2 })]);
  });

  it("ranks object dwell from mesh_visibility summaries (#37)", async () => {
    await insertEvents(db, [
      base("mesh_visibility", T0 + 1_000, {
        mesh: "product-hero",
        visibleMs: 4200,
        centeredMs: 1800,
        maxScreenFraction: 0.42,
      }),
      base("mesh_visibility", T0 + 6_000, {
        mesh: "product-hero",
        visibleMs: 800,
        centeredMs: 200,
        maxScreenFraction: 0.51,
      }),
      base("mesh_visibility", T0 + 2_000, { mesh: "backdrop", visibleMs: 9000 }),
    ]);
    const dwell = await runDuckdbQuery<{
      mesh: string;
      visible_ms: number;
      centered_ms: number;
      max_screen_fraction: number;
      samples: number;
    }>(db, buildMeshDwell(PID, RANGE, duckdbDialect));
    // Ranked by total dwell: backdrop (9000) before product-hero (5000).
    expect(dwell.map((r) => r.mesh)).toEqual(["backdrop", "product-hero"]);
    const hero = dwell.find((r) => r.mesh === "product-hero")!;
    expect(Number(hero.visible_ms)).toBe(5000);
    expect(Number(hero.centered_ms)).toBe(2000);
    expect(Number(hero.max_screen_fraction)).toBeCloseTo(0.51, 5);
    expect(Number(hero.samples)).toBe(2);
  });

  it("breaks interactions down per mesh and kind (#72)", async () => {
    await insertEvents(db, [
      base("mesh_interaction", T0 + 1_000, { mesh: "door", kind: "hover", source: "mouse" }),
      base("mesh_interaction", T0 + 2_000, { mesh: "door", kind: "hover", source: "mouse" }),
      base("mesh_interaction", T0 + 3_000, { mesh: "door", kind: "click", source: "mouse" }),
      base("mesh_interaction", T0 + 4_000, { mesh: "lever", kind: "drag", source: "mouse" }),
    ]);
    const rows = await runDuckdbQuery<{ mesh: string; kind: string; count: number }>(
      db,
      buildMeshInteractionKinds(PID, RANGE, duckdbDialect),
    );
    const byPair = Object.fromEntries(rows.map((r) => [`${r.mesh}/${r.kind}`, Number(r.count)]));
    expect(byPair).toEqual({ "door/hover": 2, "door/click": 1, "lever/drag": 1 });
    // Ranked by count: the two door hovers lead.
    expect(rows[0]).toMatchObject({ mesh: "door", kind: "hover" });
  });

  it("splits per-mesh interaction counts by input source (#74)", async () => {
    await insertEvents(db, [
      base("mesh_interaction", T0 + 1_000, { mesh: "door", kind: "pick", source: "mouse" }),
      base("mesh_interaction", T0 + 2_000, { mesh: "door", kind: "pick", source: "touch" }),
      base("mesh_interaction", T0 + 3_000, { mesh: "door", kind: "pick", source: "touch" }),
      base("pointer_click", T0 + 4_000, { hitMesh: "lever", source: "xr-controller" }),
    ]);
    const rows = await runDuckdbQuery<{ mesh: string; source: string; count: number }>(
      db,
      buildTopMeshesBySource(PID, RANGE, duckdbDialect),
    );
    const byPair = Object.fromEntries(rows.map((r) => [`${r.mesh}/${r.source}`, Number(r.count)]));
    expect(byPair).toEqual({ "door/touch": 2, "door/mouse": 1, "lever/xr-controller": 1 });
    // Ranked by count: door's two touch picks lead.
    expect(rows[0]).toMatchObject({ mesh: "door", source: "touch" });
  });

  it("buckets per-mesh interaction counts into a trend (#74)", async () => {
    await insertEvents(db, [
      base("mesh_interaction", T0 + 1_000, { mesh: "door", kind: "pick", source: "mouse" }),
      base("mesh_interaction", T0 + 2_000, { mesh: "door", kind: "pick", source: "mouse" }),
      // A second window 120 s later — distinct bucket at a 60 s interval.
      base("mesh_interaction", T0 + 122_000, { mesh: "door", kind: "pick", source: "mouse" }),
    ]);
    const rows = await runDuckdbQuery<{ mesh: string; bucket: number; count: number }>(
      db,
      buildTopMeshesTrend(
        PID,
        { since: T0 - 60_000, until: T0 + 180_000, interval: 60 },
        duckdbDialect,
      ),
    );
    const door = rows.filter((r) => r.mesh === "door");
    // Two distinct time buckets: the first holds 2 picks, the later holds 1.
    expect(door).toHaveLength(2);
    expect(door.map((r) => Number(r.count))).toEqual([2, 1]);
    // Ordered oldest bucket first.
    expect(Number(door[0]!.bucket)).toBeLessThan(Number(door[1]!.bucket));
  });

  it("ranks the most-used input actions by source (#75)", async () => {
    await insertEvents(db, [
      base("input_action", T0 + 1_000, { action: "rotate-left", code: "KeyA", source: "keyboard" }),
      base("input_action", T0 + 2_000, { action: "rotate-left", code: "KeyA", source: "keyboard" }),
      base("input_action", T0 + 3_000, { action: "next-camera", button: 1, source: "gamepad" }),
    ]);
    const rows = await runDuckdbQuery<{ action: string; source: string; count: number }>(
      db,
      buildTopInputActions(PID, RANGE, duckdbDialect),
    );
    const byPair = Object.fromEntries(
      rows.map((r) => [`${r.action}/${r.source}`, Number(r.count)]),
    );
    expect(byPair).toEqual({ "rotate-left/keyboard": 2, "next-camera/gamepad": 1 });
    // Ranked by count: the repeated rotate-left leads.
    expect(rows[0]).toMatchObject({ action: "rotate-left", source: "keyboard" });
  });

  it("counts dead clicks (pointer_click that hit nothing) (#46)", async () => {
    await insertEvents(db, [
      base("pointer_click", T0 + 1_000, { screen: [0.4, 0.6], hitMesh: "box", source: "mouse" }),
      // Two misses: empty space, no hitMesh.
      base("pointer_click", T0 + 2_000, { screen: [0.1, 0.1], source: "mouse" }),
      base("pointer_click", T0 + 3_000, { screen: [0.9, 0.9], source: "mouse" }),
    ]);
    const [stats] = await runDuckdbQuery<{ total_clicks: number; dead_clicks: number }>(
      db,
      buildDeadClicks(PID, RANGE, duckdbDialect),
    );
    expect(Number(stats!.total_clicks)).toBe(3);
    expect(Number(stats!.dead_clicks)).toBe(2);
  });

  it("detects rage clicks: rapid repeats on the same mesh (#47)", async () => {
    await insertEvents(db, [
      // Burst: 3 clicks on "button" within ~600ms -> one rage cluster.
      base("pointer_click", T0 + 1_000, { screen: [0.5, 0.5], hitMesh: "button", source: "mouse" }),
      base("pointer_click", T0 + 1_300, { screen: [0.5, 0.5], hitMesh: "button", source: "mouse" }),
      base("pointer_click", T0 + 1_600, { screen: [0.5, 0.5], hitMesh: "button", source: "mouse" }),
      // Lone click on another mesh -> below threshold, not a cluster.
      base("pointer_click", T0 + 5_000, { screen: [0.2, 0.2], hitMesh: "panel", source: "mouse" }),
    ]);
    const clusters = await runDuckdbQuery<{ mesh: string; clicks: number }>(
      db,
      buildRageClicks(PID, { ...RANGE, interval: 2 }, duckdbDialect),
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.mesh).toBe("button");
    expect(Number(clusters[0]!.clicks)).toBe(3);
  });

  it("rolls up hover hesitation per mesh from hover_dwell (#48)", async () => {
    await insertEvents(db, [
      // Two hover episodes on "product" (dwellMs -> visible_ms) and one on "panel".
      base("hover_dwell", T0 + 1_000, { mesh: "product", dwellMs: 1200, source: "mouse" }),
      base("hover_dwell", T0 + 2_000, { mesh: "product", dwellMs: 800, source: "mouse" }),
      base("hover_dwell", T0 + 3_000, { mesh: "panel", dwellMs: 500, source: "mouse" }),
    ]);
    const rows = await runDuckdbQuery<{
      mesh: string;
      dwell_ms: number;
      max_dwell_ms: number;
      episodes: number;
    }>(db, buildHoverDwell(PID, RANGE, duckdbDialect));
    // Ranked by total dwell: product (2000) before panel (500).
    expect(rows.map((r) => r.mesh)).toEqual(["product", "panel"]);
    const product = rows.find((r) => r.mesh === "product")!;
    expect(Number(product.dwell_ms)).toBe(2000);
    expect(Number(product.max_dwell_ms)).toBe(1200);
    expect(Number(product.episodes)).toBe(2);
  });

  it("rolls up shader/pipeline compile stalls per phase from compile_stall (#42)", async () => {
    await insertEvents(db, [
      // Two shader compiles (durationMs -> visible_ms) and one pipeline compile.
      base("compile_stall", T0 + 1_000, { durationMs: 18, phase: "shader" }),
      base("compile_stall", T0 + 1_500, { durationMs: 12, phase: "shader" }),
      base("compile_stall", T0 + 2_000, { durationMs: 40, phase: "pipeline" }),
    ]);
    const rows = await runDuckdbQuery<{
      phase: string;
      stalls: number;
      total_ms: number;
      avg_ms: number;
      max_ms: number;
    }>(db, buildCompileStalls(PID, RANGE, duckdbDialect));
    // Ranked by total compile time: pipeline (40) before shader (30).
    expect(rows.map((r) => r.phase)).toEqual(["pipeline", "shader"]);
    const shader = rows.find((r) => r.phase === "shader")!;
    expect(Number(shader.stalls)).toBe(2);
    expect(Number(shader.total_ms)).toBe(30);
    expect(Number(shader.max_ms)).toBe(18);
    const pipeline = rows.find((r) => r.phase === "pipeline")!;
    expect(Number(pipeline.stalls)).toBe(1);
    expect(Number(pipeline.total_ms)).toBe(40);
  });

  it("summarizes GPU/memory footprint from resource_sample (#44)", async () => {
    await insertEvents(db, [
      // Two full samples plus one partial (only heap + triangles reported). The
      // partial leaves texture/geometry/vertices at 0, which NULLIF excludes
      // from the averages but not from the peaks.
      base("resource_sample", T0 + 1_000, {
        textureBytes: 1_000_000,
        geometryBytes: 500_000,
        triangles: 120_000,
        vertices: 90_000,
        jsHeapBytes: 40_000_000,
      }),
      base("resource_sample", T0 + 2_000, {
        textureBytes: 3_000_000,
        geometryBytes: 700_000,
        triangles: 180_000,
        vertices: 130_000,
        jsHeapBytes: 60_000_000,
      }),
      base("resource_sample", T0 + 3_000, { triangles: 240_000, jsHeapBytes: 80_000_000 }),
    ]);
    const [row] = await runDuckdbQuery<{
      samples: number;
      avg_js_heap_bytes: number;
      max_js_heap_bytes: number;
      avg_triangles: number;
      max_triangles: number;
      avg_vertices: number;
      max_vertices: number;
      avg_texture_bytes: number;
      max_texture_bytes: number;
      avg_geometry_bytes: number;
      max_geometry_bytes: number;
    }>(db, buildResourceSummary(PID, RANGE, duckdbDialect));
    expect(Number(row!.samples)).toBe(3);
    // Heap is reported on every sample: mean of 40/60/80M, peak 80M.
    expect(Number(row!.avg_js_heap_bytes)).toBe(60_000_000);
    expect(Number(row!.max_js_heap_bytes)).toBe(80_000_000);
    // Triangles reported on all three: mean of 120/180/240k, peak 240k.
    expect(Number(row!.avg_triangles)).toBe(180_000);
    expect(Number(row!.max_triangles)).toBe(240_000);
    // Texture/geometry/vertices only on the two full samples — the partial's 0
    // is excluded from the mean (NULLIF) but the peak is the real max.
    expect(Number(row!.avg_texture_bytes)).toBe(2_000_000);
    expect(Number(row!.max_texture_bytes)).toBe(3_000_000);
    expect(Number(row!.avg_geometry_bytes)).toBe(600_000);
    expect(Number(row!.avg_vertices)).toBe(110_000);
    expect(Number(row!.max_vertices)).toBe(130_000);
  });

  it("rolls up capability fallbacks/recoveries per transition from capability_change (#49)", async () => {
    await insertEvents(db, [
      // Two WebGPU→WebGL2 backend downgrades and one quality auto-downgrade.
      base("capability_change", T0 + 1_000, {
        kind: "graphics-backend",
        from: "webgpu",
        to: "webgl2",
        reason: "device-init-failed",
      }),
      base("capability_change", T0 + 1_500, {
        kind: "graphics-backend",
        from: "webgpu",
        to: "webgl2",
      }),
      base("capability_change", T0 + 2_000, { kind: "quality", from: "high", to: "low" }),
    ]);
    const rows = await runDuckdbQuery<{
      kind: string;
      from: string;
      to: string;
      changes: number;
    }>(db, buildCapabilityChanges(PID, RANGE, duckdbDialect));
    // Ranked by count: the backend downgrade (2) before the quality drop (1).
    expect(rows.map((r) => r.kind)).toEqual(["graphics-backend", "quality"]);
    const backend = rows.find((r) => r.kind === "graphics-backend")!;
    expect(backend.from).toBe("webgpu");
    expect(backend.to).toBe("webgl2");
    expect(Number(backend.changes)).toBe(2);
    const quality = rows.find((r) => r.kind === "quality")!;
    expect(quality.from).toBe("high");
    expect(quality.to).toBe("low");
    expect(Number(quality.changes)).toBe(1);
  });

  it("summarizes perf and reads daily rollups", async () => {
    await insertEvents(db, EVENTS);
    const [perf] = await runDuckdbQuery<{ samples: number; avg_fps: number }>(
      db,
      buildPerfSummary(PID, RANGE, duckdbDialect),
    );
    expect(perf).toMatchObject({ samples: 1, avg_fps: 60 });

    // Daily rollups bucket by date; the upper bound is exclusive at day
    // granularity, so span a full day on either side.
    const dayRange = { since: T0 - 86_400_000, until: T0 + 86_400_000 };
    const daily = await runDuckdbQuery<{ avg_fps: number }>(
      db,
      buildPerfDaily(PID, dayRange, duckdbDialect),
    );
    expect(daily[0]?.avg_fps).toBe(60);

    const evDaily = await runDuckdbQuery<{ event_type: string; events: number }>(
      db,
      buildEventsDaily(PID, dayRange, duckdbDialect),
    );
    expect(evDaily.reduce((n, r) => n + Number(r.events), 0)).toBe(5);
  });

  it("computes per-session resource percentiles and stability counts", async () => {
    // Two sessions of resource_sample: s1 footprint is heavier than s2. Each
    // session's median heap is taken first, then the median across sessions.
    const samples: AnyEvent[] = [
      base("resource_sample", T0 + 1_000, { jsHeapBytes: 100, textureBytes: 10, triangles: 1000 }),
      base("resource_sample", T0 + 2_000, { jsHeapBytes: 300, textureBytes: 30, triangles: 3000 }),
      {
        ...base("resource_sample", T0 + 3_000, {
          jsHeapBytes: 200,
          textureBytes: 20,
          triangles: 2000,
        }),
        sessionId: "s2",
      } as AnyEvent,
      // Stability incidents: one context loss and two compile stalls.
      base("context_lost", T0 + 4_000, {}),
      base("compile_stall", T0 + 5_000, { phase: "program", durationMs: 12 }),
      base("compile_stall", T0 + 6_000, { phase: "pipeline", durationMs: 8 }),
    ];
    await insertEvents(db, samples);

    const [res] = await runDuckdbQuery<{
      sessions: number;
      samples: number;
      p50_js_heap_bytes: number;
      p50_triangles: number;
    }>(db, buildResourcePercentiles(PID, RANGE, duckdbDialect));
    // s1 median heap = median(100,300) = 200; s2 = 200. Median across = 200.
    expect(Number(res.sessions)).toBe(2);
    expect(Number(res.samples)).toBe(3);
    expect(Number(res.p50_js_heap_bytes)).toBe(200);
    expect(Number(res.p50_triangles)).toBe(2000);

    const [stab] = await runDuckdbQuery<{
      context_losses: number;
      compile_stalls: number;
      incidents: number;
    }>(db, buildStabilityCounts(PID, RANGE, duckdbDialect));
    expect(Number(stab.context_losses)).toBe(1);
    expect(Number(stab.compile_stalls)).toBe(2);
    expect(Number(stab.incidents)).toBe(3);
  });

  it("counts graphics_diagnostic incidents by severity/category/backend, folding rollups and markers (#16)", async () => {
    await insertEvents(db, [
      // Two discrete device-lost markers (no `count`) on WebGPU: fold in as 1 each.
      base("graphics_diagnostic", T0 + 1_000, {
        severity: "fatal",
        category: "device-lost",
        backend: "webgpu",
      }),
      base("graphics_diagnostic", T0 + 2_000, {
        severity: "fatal",
        category: "device-lost",
        backend: "webgpu",
      }),
      // A per-session rollup of 5 validation warnings on WebGL2: folds in as 5.
      base("graphics_diagnostic", T0 + 3_000, {
        severity: "warning",
        category: "validation",
        backend: "webgl2",
        count: 5,
      }),
      // A diagnostic with no backend: groups under '' (unknown).
      base("graphics_diagnostic", T0 + 4_000, {
        severity: "error",
        category: "shader-compile",
      }),
    ]);
    const rows = await runDuckdbQuery<{
      severity: string;
      category: string;
      backend: string;
      incidents: number;
    }>(db, buildGraphicsDiagnosticCounts(PID, RANGE, duckdbDialect));

    const cell = (severity: string, category: string, backend: string) =>
      rows.find((r) => r.severity === severity && r.category === category && r.backend === backend);

    // Two markers fold into a single (fatal, device-lost, webgpu) cell with count 2.
    expect(Number(cell("fatal", "device-lost", "webgpu")!.incidents)).toBe(2);
    // The rollup of 5 lands as 5, not 1.
    expect(Number(cell("warning", "validation", "webgl2")!.incidents)).toBe(5);
    // The backend-less diagnostic groups under '' (unknown).
    expect(Number(cell("error", "shader-compile", "")!.incidents)).toBe(1);
    expect(rows).toHaveLength(3);

    // Derived breakdowns (what the dashboard folds): by-category, by-severity,
    // by-backend all sum to the same grand total of 8 incidents.
    const total = rows.reduce((n, r) => n + Number(r.incidents), 0);
    expect(total).toBe(8);
  });

  it("lists distinct scenes, a time-series, and event-type counts", async () => {
    await insertEvents(db, EVENTS);
    const scenes = await runDuckdbQuery<{ scene_id: string; events: number }>(
      db,
      buildDistinctScenes(PID, RANGE, duckdbDialect),
    );
    expect(scenes).toEqual([expect.objectContaining({ scene_id: "lobby", events: 5 })]);

    const series = await runDuckdbQuery(
      db,
      buildTimeseries(PID, { ...RANGE, interval: 60 }, duckdbDialect),
    );
    expect(series.length).toBeGreaterThan(0);

    const counts = await runDuckdbQuery<{ event_type: string; count: number }>(
      db,
      buildEventTypeCounts(PID, RANGE, duckdbDialect),
    );
    const byType = Object.fromEntries(counts.map((c) => [c.event_type, Number(c.count)]));
    expect(byType.pointer_click).toBe(1);
  });

  it("returns a replay-complete session timeline (read + stream)", async () => {
    await insertEvents(db, EVENTS);
    const timeline = await getSessionEvents(db, PID, "s1");
    expect(timeline.map((e) => e.type)).toEqual([
      "session_start",
      "camera_sample",
      "pointer_move",
      "pointer_click",
      "frame_perf",
    ]);

    const streamed: string[] = [];
    for await (const event of streamSessionEvents(db, PID, "s1")) streamed.push(event.type);
    expect(streamed).toEqual(timeline.map((e) => e.type));

    const meta = await getSessionMeta(db, PID, "s1");
    expect(meta).toMatchObject({
      sessionId: "s1",
      scene: { cameraType: "arc-rotate" },
      user: { id: "anon-1" },
    });
  });

  it("splits node_transform into node_samples and merges it back into the timeline (ADR 0027)", async () => {
    const withActors: AnyEvent[] = [
      ...EVENTS,
      base("node_transform", T0 + 1_500, {
        nodeId: "npc-guard",
        position: [1, 0, 3],
        rotation: [0, 0, 0, 1],
      }),
      base("node_transform", T0 + 3_500, {
        nodeId: "npc-guard",
        boneId: "mixamorig:RightHand",
        position: [0, 0.2, 0],
        rotation: [0, 0.7071, 0, 0.7071],
        scale: [1, 1, 1],
      }),
    ];
    await insertEvents(db, withActors);

    // node_transform is NOT in the wide events table (it has its own store), so
    // session listings / event-type counts never scan it.
    const counts = await runDuckdbQuery<{ event_type: string; count: number }>(
      db,
      buildEventTypeCounts(PID, RANGE, duckdbDialect),
    );
    expect(counts.some((c) => c.event_type === "node_transform")).toBe(false);

    // Replay reconstructs the samples and merges both streams by ts.
    const timeline = await getSessionEvents(db, PID, "s1");
    expect(timeline.map((e) => e.type)).toEqual([
      "session_start",
      "camera_sample",
      "node_transform",
      "pointer_move",
      "pointer_click",
      "node_transform",
      "frame_perf",
    ]);
    const tier2 = timeline.find(
      (e): e is Extract<AnyEvent, { type: "node_transform" }> =>
        e.type === "node_transform" && e.ts === T0 + 3_500,
    );
    expect(tier2).toMatchObject({
      nodeId: "npc-guard",
      boneId: "mixamorig:RightHand",
      scale: [1, 1, 1],
    });

    const streamed: string[] = [];
    for await (const event of streamSessionEvents(db, PID, "s1")) streamed.push(event.type);
    expect(streamed).toEqual(timeline.map((e) => e.type));
  });

  it("round-trips a Tier-1 subtree child's childPath through node_samples (ADR 0033)", async () => {
    const withChild: AnyEvent[] = [
      ...EVENTS,
      base("node_transform", T0 + 1_500, {
        nodeId: "rig",
        childPath: "Body/Hand",
        position: [4, 0, 0],
        rotation: [0, 0, 0, 1],
      }),
    ];
    await insertEvents(db, withChild);

    const timeline = await getSessionEvents(db, PID, "s1");
    const child = timeline.find(
      (e): e is Extract<AnyEvent, { type: "node_transform" }> =>
        e.type === "node_transform" && e.ts === T0 + 1_500,
    );
    expect(child).toMatchObject({
      nodeId: "rig",
      childPath: "Body/Hand",
      position: [4, 0, 0],
    });
    // A root sample (no childPath) must not gain a spurious one.
    expect((child as Record<string, unknown>).boneId).toBeUndefined();
  });

  it("stores and reads back a scene proxy", async () => {
    const proxy: SceneProxy = {
      version: 1,
      sceneId: "lobby",
      kind: "aabb",
      bounds: [-1, -1, -1, 1, 1, 1],
      upAxis: "y",
      unitScale: 1,
      meshes: [{ name: "box", aabb: [-1, -1, -1, 1, 1, 1] }],
      meshCount: 1,
      contentHash: "hash-1",
      capturedAt: T0,
      sdkVersion: "0.1.0",
    };
    const saved = await upsertSceneProxy(db, PID, proxy, "Lobby");
    expect(saved).toMatchObject({ sceneId: "lobby", kind: "proxy", label: "Lobby" });
    expect(saved.bounds).toEqual([-1, -1, -1, 1, 1, 1]);
    expect(saved.capturedAt?.getTime()).toBe(T0);

    const fetched = await getSceneRepresentation(db, PID, "lobby");
    expect(fetched?.proxy?.meshes[0]?.name).toBe("box");

    const list = await listSceneRepresentations(db, PID);
    expect(list).toEqual([expect.objectContaining({ sceneId: "lobby", label: "Lobby" })]);
  });
});

describe("duckdb persistence", () => {
  it("persists events across reopen of the same file", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "uptimizr-duck-"));
    const file = join(dir, "store.duckdb");

    const first = await createDuckdbClient(file);
    await migrateDuckdb(first);
    await insertEvents(first, EVENTS);
    await first.close();

    const second = await createDuckdbClient(file);
    const sessions = await runDuckdbQuery(second, buildListSessions(PID, RANGE, duckdbDialect));
    expect(sessions).toEqual([expect.objectContaining({ session_id: "s1", events: 5 })]);
    await second.close();

    await rm(dir, { recursive: true, force: true });
  });
});
