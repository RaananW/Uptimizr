/**
 * Live store tests for `@uptimizr/db-mssql` (ADR 0020, #85): metadata
 * (projects, API keys, scene registry), replay-complete session reads (wide
 * events + `node_samples`, ADR 0027), the JSON payload / JSON-vector round
 * trip, concurrent idempotent migrations, and a cross-engine smoke that
 * executes **every** `build*` aggregation of `@uptimizr/db` — including the
 * ones outside `PARITY_CASES` and the filtered / spatial option variants — on
 * SQL Server and DuckDB over the same fixtures and asserts identical rows.
 *
 * Skipped gracefully when no SQL Server is reachable (`MSSQL_URL` / the
 * discrete `MSSQL_*` variables; defaults to the local docker-compose instance).
 * Works in a throwaway database dropped on teardown.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent, SceneProxy } from "@uptimizr/schema";
import * as db from "@uptimizr/db";
import {
  PARITY_EVENTS,
  PARITY_PROJECT_ID,
  PARITY_RANGE,
  PARITY_T0,
  buildEventTypeCounts,
  buildListSessions,
  createDuckdbClient,
  diffParity,
  duckdbDialect,
  duckdbInsertEvents,
  migrateDuckdb,
  mssqlDialect,
  readDbSettings,
  runDuckdbQuery,
  type Dialect,
  type DuckdbClient,
  type MssqlSettings,
  type QuerySpec,
} from "@uptimizr/db";
import type { MssqlClient } from "../client.js";
import { migrateMssql } from "../migrations.js";
import { getSessionEvents, getSessionMeta, insertEvents, streamSessionEvents } from "../events.js";
import { createApiKey, createProject, getProject, resolveApiKey } from "../projects.js";
import {
  getSceneRepresentation,
  listSceneRepresentations,
  upsertSceneProxy,
} from "../sceneRegistry.js";
import { runMssqlQuery } from "../queries.js";
import { discardTestDatabase, mssqlReachable, openTestDatabase } from "./probe.js";

const SETTINGS: MssqlSettings = readDbSettings().mssql;
const DATABASE = "uptimizr_mssql_store_test";

const available = await mssqlReachable(SETTINGS);

const PID = PARITY_PROJECT_ID;
const T0 = PARITY_T0;

function ev(type: string, ts: number, extra: Record<string, unknown> = {}): AnyEvent {
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

/**
 * The parity fixtures plus one or more events of every type they lack, so the
 * cross-engine smoke below exercises non-empty results for the builders that
 * `PARITY_CASES` only covers on empty input.
 */
const EXTENDED_EVENTS: AnyEvent[] = [
  ...PARITY_EVENTS,
  ev("mesh_interaction", T0 + 2_500, { mesh: "box", kind: "hover", source: "mouse" }),
  ev("mesh_interaction", T0 + 2_600, {
    mesh: "box",
    kind: "pick",
    source: "touch",
    point: [0.2, 0.2, 0.2],
  }),
  ev("mesh_interaction", T0 + 4_500, {
    mesh: "sphere",
    kind: "drag",
    source: "mouse",
    point: [5, 5, 5],
  }),
  ev("hover_dwell", T0 + 2_700, { mesh: "box", dwellMs: 1200, source: "mouse" }),
  ev("hover_dwell", T0 + 2_800, { mesh: "sphere", dwellMs: 300, source: "mouse" }),
  ev("compile_stall", T0 + 5_500, { durationMs: 18, phase: "shader" }),
  ev("compile_stall", T0 + 5_600, { durationMs: 40, phase: "pipeline" }),
  ev("resource_sample", T0 + 5_700, {
    textureBytes: 1_000_000,
    geometryBytes: 500_000,
    triangles: 120_000,
    vertices: 90_000,
    jsHeapBytes: 40_000_000,
  }),
  ev("capability_change", T0 + 5_800, {
    kind: "graphics-backend",
    from: "webgpu",
    to: "webgl2",
    reason: "device-init-failed",
  }),
  ev("camera_gesture", T0 + 5_900, { kind: "orbit", durationMs: 500 }),
  ev("input_action", T0 + 6_100, { action: "rotate-left", code: "KeyA", source: "keyboard" }),
  ev("scene_change", T0 + 6_200, { sceneId: "lobby" }),
  ev("scene_change", T0 + 6_300, { sceneId: "arena" }),
  ev("context_lost", T0 + 6_400, {}),
  ev("custom", T0 + 6_500, { name: "add_to_cart", props: { sku: "box-1" } }),
  ev("custom", T0 + 6_600, { name: "red" }),
  ev("session_end", T0 + 9_500, { durationMs: 9_500, reason: "unload" }),
  ev("session_end", T0 + 19_000, { sessionId: "s2", sceneId: "arena", durationMs: 9_000 }),
];

const SCENE_PROXY: SceneProxy = {
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

describe.skipIf(!available)("mssql store", () => {
  let ms: MssqlClient;
  let duck: DuckdbClient;

  beforeAll(async () => {
    ms = await openTestDatabase(SETTINGS, DATABASE);
    await migrateMssql(ms);
    duck = await createDuckdbClient(":memory:");
    await migrateDuckdb(duck);
  });

  beforeEach(async () => {
    await ms.command(
      `TRUNCATE TABLE dbo.events; TRUNCATE TABLE dbo.node_samples; TRUNCATE TABLE dbo.projects;
       TRUNCATE TABLE dbo.api_keys; TRUNCATE TABLE dbo.scene_representations;`,
    );
  });

  afterAll(async () => {
    await discardTestDatabase(SETTINGS, ms, DATABASE);
    if (duck) await duck.close();
  });

  it("re-runs migrations idempotently, also from concurrent boots", async () => {
    await Promise.all([migrateMssql(ms), migrateMssql(ms)]);
    await migrateMssql(ms);
    const tables = await ms.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = N'dbo' ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      "api_keys",
      "events",
      "events_daily",
      "node_samples",
      "perf_daily",
      "projects",
      "scene_representations",
    ]);
  });

  it("issues and resolves API keys (hashed, never plaintext)", async () => {
    const project = await createProject(ms, "Demo");
    expect(project.orgId).toBeNull();
    expect(project.createdAt).toBeInstanceOf(Date);
    expect(await getProject(ms, project.id)).toEqual(project);
    expect(await getProject(ms, "nope")).toBeNull();

    const { key, record } = await createApiKey(ms, project.id);
    expect(key.startsWith("utk_")).toBe(true);
    expect(record).toMatchObject({ projectId: project.id, capability: "query", revokedAt: null });
    expect(record.keyPrefix).toBe(key.slice(0, record.keyPrefix.length));

    const stored = await ms.query<{ key_hash: string }>("SELECT key_hash FROM dbo.api_keys");
    expect(stored[0]?.key_hash).not.toBe(key);

    expect(await resolveApiKey(ms, key)).toEqual({ projectId: project.id, capability: "query" });
    expect(await resolveApiKey(ms, "utk_unknown")).toBeNull();

    const ingest = await createApiKey(ms, project.id, "ingest");
    expect(await resolveApiKey(ms, ingest.key)).toEqual({
      projectId: project.id,
      capability: "ingest",
    });
  });

  it("ingests events and lists sessions", async () => {
    await insertEvents(ms, PARITY_EVENTS);
    const sessions = await runMssqlQuery<{ session_id: string; events: number }>(
      ms,
      buildListSessions(PID, PARITY_RANGE, mssqlDialect),
    );
    expect(sessions.map((s) => s.session_id).sort()).toEqual(["s1", "s2"]);
    expect(typeof sessions[0]?.events).toBe("number");
  });

  it("returns a replay-complete session timeline (read + stream) with exact payloads", async () => {
    await insertEvents(ms, PARITY_EVENTS);
    const timeline = await getSessionEvents(ms, PID, "s1");
    const expected = PARITY_EVENTS.filter((e) => e.sessionId === "s1").sort((a, b) => a.ts - b.ts);
    // The JSON payload round-trips every validated event byte-for-byte in value terms.
    expect(timeline).toEqual(expected);

    const streamed: AnyEvent[] = [];
    for await (const event of streamSessionEvents(ms, PID, "s1")) streamed.push(event);
    expect(streamed).toEqual(timeline);

    const meta = await getSessionMeta(ms, PID, "s1");
    expect(meta).toMatchObject({
      sessionId: "s1",
      startedAt: "2024-06-16 10:00:00",
      scene: { cameraType: "arc-rotate" },
      user: { id: "anon-1" },
      device: { engine: "webgpu" },
    });
    expect(await getSessionMeta(ms, PID, "missing")).toBeNull();
  });

  it("splits node_transform into node_samples and merges it back into the timeline (ADR 0027)", async () => {
    await insertEvents(ms, [
      ...PARITY_EVENTS,
      ev("node_transform", T0 + 1_500, {
        nodeId: "npc-guard",
        position: [1, 0, 3],
        rotation: [0, 0, 0, 1],
      }),
      ev("node_transform", T0 + 3_500, {
        nodeId: "npc-guard",
        boneId: "mixamorig:RightHand",
        position: [0, 0.2, 0],
        rotation: [0, 0.7071, 0, 0.7071],
        scale: [1, 1, 1],
      }),
      ev("node_transform", T0 + 1_600, {
        nodeId: "rig",
        childPath: "Body/Hand",
        position: [4, 0, 0],
        rotation: [0, 0, 0, 1],
      }),
    ]);

    const counts = await runMssqlQuery<{ event_type: string }>(
      ms,
      buildEventTypeCounts(PID, PARITY_RANGE, mssqlDialect),
    );
    expect(counts.some((c) => c.event_type === "node_transform")).toBe(false);

    const timeline = await getSessionEvents(ms, PID, "s1");
    expect(timeline.map((e) => e.type)).toEqual([
      "session_start",
      "camera_sample",
      "node_transform",
      "node_transform",
      "pointer_click",
      "camera_sample",
      "node_transform",
      "pointer_click",
      "frame_perf",
      "frame_perf",
      "mesh_visibility",
      "mesh_visibility",
      "xr_boundary_proximity",
    ]);
    const nodes = timeline.filter(
      (e): e is Extract<AnyEvent, { type: "node_transform" }> => e.type === "node_transform",
    );
    expect(nodes[0]).toMatchObject({ nodeId: "npc-guard", position: [1, 0, 3] });
    expect((nodes[0] as Record<string, unknown>).childPath).toBeUndefined();
    expect(nodes[1]).toMatchObject({ nodeId: "rig", childPath: "Body/Hand", position: [4, 0, 0] });
    expect(nodes[2]).toMatchObject({
      nodeId: "npc-guard",
      boneId: "mixamorig:RightHand",
      scale: [1, 1, 1],
    });

    const streamed: string[] = [];
    for await (const event of streamSessionEvents(ms, PID, "s1")) streamed.push(event.type);
    expect(streamed).toEqual(timeline.map((e) => e.type));
  });

  it("stores vectors as JSON arrays and reads them back through the dialect", async () => {
    await insertEvents(ms, PARITY_EVENTS);
    const rows = await ms.query<{ position: string; x: number; n: number }>(
      `SELECT TOP 1 position, ${mssqlDialect.arrayLength("position")} AS n,
              TRY_CONVERT(float, JSON_VALUE(position, '$[0]')) AS x
       FROM dbo.events WHERE event_type = N'camera_sample' ORDER BY ts ASC`,
    );
    expect(rows[0]?.position).toMatch(/^\[.*\]$/);
    expect(rows[0]?.n).toBe(3);
    expect(typeof rows[0]?.x).toBe("number");
    const missing = await ms.query<{ n: number; x: number | null }>(
      `SELECT TOP 1 ${mssqlDialect.arrayLength("hit_point")} AS n,
              TRY_CONVERT(float, JSON_VALUE(hit_point, '$[0]')) AS x
       FROM dbo.events WHERE event_type = N'session_start'`,
    );
    expect(missing[0]).toEqual({ n: 0, x: null });
  });

  it("stores and reads back a scene proxy, keeping the label on relabel-less upserts", async () => {
    const saved = await upsertSceneProxy(ms, PID, SCENE_PROXY, "Lobby");
    expect(saved).toMatchObject({ sceneId: "lobby", kind: "proxy", label: "Lobby", upAxis: "y" });
    expect(saved.bounds).toEqual([-1, -1, -1, 1, 1, 1]);
    expect(saved.capturedAt?.getTime()).toBe(T0);

    const again = await upsertSceneProxy(ms, PID, { ...SCENE_PROXY, contentHash: "hash-2" });
    expect(again).toMatchObject({ label: "Lobby", contentHash: "hash-2" });

    const fetched = await getSceneRepresentation(ms, PID, "lobby");
    expect(fetched?.proxy?.meshes[0]?.name).toBe("box");
    expect(await getSceneRepresentation(ms, PID, "nope")).toBeNull();

    const list = await listSceneRepresentations(ms, PID);
    expect(list).toEqual([
      expect.objectContaining({ sceneId: "lobby", label: "Lobby", contentHash: "hash-2" }),
    ]);
  });

  describe("every aggregation matches DuckDB on the extended fixtures", () => {
    type Builder = (projectId: string, opts: never, d: Dialect) => QuerySpec;
    const builders = Object.entries(db)
      .filter(([name, value]) => /^build[A-Z]/.test(name) && typeof value === "function")
      .map(([name, value]) => [name, value as Builder] as const);

    const BASE_OPTS = {
      ...PARITY_RANGE,
      limit: 50,
      cellSize: 1,
      bins: 8,
      bucketSize: 1,
      bucket: 5,
      bucketMs: 60_000,
      interval: 60,
      windowMs: 5_000,
      fpsThreshold: 30,
      stallMs: 10,
      rapidTurn: 0.5,
      moveThreshold: 0.05,
      minRepeats: 1,
      center: [0, 0, 0],
      bands: [1_000, 3_000, 5_000],
      steps: [{ type: "session_start" }, { type: "pointer_click", mesh: "box" }],
      variant: { type: "custom", name: "red" },
      conversion: { type: "custom", name: "add_to_cart" },
    };
    const VARIANTS: Record<string, Record<string, unknown>> = {
      base: BASE_OPTS,
      filtered: {
        ...BASE_OPTS,
        scene: "lobby",
        source: "mouse",
        session: "s1",
        cameraType: "arc-rotate",
        mesh: "box",
        type: "pointer_click",
        severity: "error",
        category: "shader-compile",
        errorKind: "error",
      },
      spatial: {
        ...BASE_OPTS,
        groupByOrigin: true,
        originVoxel: [0, 0, 0],
        region: [-10, -10, -10, 10, 10, 10],
      },
    };

    /** Wall-clock projections render differently per engine; ignore them. */
    const TEMPORAL = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

    beforeAll(async () => {
      await duckdbInsertEvents(duck, EXTENDED_EVENTS);
    });

    it("enumerates the full builder surface", () => {
      expect(builders.length).toBeGreaterThanOrEqual(69);
    });

    for (const [variant, baseOpts] of Object.entries(VARIANTS)) {
      for (const [name, build] of builders) {
        // The per-session trajectory is the one builder with a required session.
        const opts = name === "buildSessionTrajectory" ? { session: "s1", ...baseOpts } : baseOpts;
        it(`${name} (${variant})`, async () => {
          await insertEvents(ms, EXTENDED_EVENTS);
          const pgRows = await runMssqlQuery<Record<string, unknown>>(
            ms,
            build(PID, opts as never, mssqlDialect),
          );
          const duckRows = await runDuckdbQuery<Record<string, unknown>>(
            duck,
            build(PID, opts as never, duckdbDialect),
          );
          const first = duckRows[0] ?? {};
          const ignoreColumns = Object.keys(first).filter(
            (k) => typeof first[k] === "string" && TEMPORAL.test(first[k] as string),
          );
          const sortKeys = Object.keys(first).filter((k) => !ignoreColumns.includes(k));
          const errors = diffParity(pgRows, duckRows, { sortKeys, ignoreColumns });
          expect(errors, errors.join("\n")).toEqual([]);
        });
      }
    }
  });
});
