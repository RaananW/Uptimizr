/**
 * Live store tests for `@uptimizr/db-postgres` (ADR 0020, #84): metadata
 * (projects, API keys, scene registry), replay-complete session reads (wide
 * events + `node_samples`, ADR 0027), the `jsonb` payload round trip, concurrent
 * idempotent migrations, and a cross-engine smoke that executes **every**
 * `build*` aggregation of `@uptimizr/db` — including the ones outside
 * `PARITY_CASES` and the filtered / spatial option variants — on Postgres and
 * DuckDB over the same fixtures and asserts identical rows.
 *
 * Skipped gracefully when no Postgres server is reachable (`POSTGRES_URL` /
 * `DATABASE_URL`; defaults to the local docker-compose instance). Works in a
 * throwaway schema dropped on teardown.
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
  hashApiKey,
  migrateDuckdb,
  postgresDialect,
  readDbSettings,
  runDuckdbQuery,
  type Dialect,
  type DuckdbClient,
  type PostgresSettings,
  type QuerySpec,
} from "@uptimizr/db";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { migratePostgres } from "../migrations.js";
import { getSessionEvents, getSessionMeta, insertEvents, streamSessionEvents } from "../events.js";
import { createApiKey, createProject, getProject, resolveApiKey } from "../projects.js";
import { listAudit, pruneAudit, recordAudit } from "../audit.js";
import {
  getSceneRepresentation,
  listSceneRepresentations,
  upsertSceneProxy,
} from "../sceneRegistry.js";
import { getSceneRegions, listSceneRegions, putSceneRegions } from "../sceneRegions.js";
import { runPostgresQuery } from "../queries.js";
import { postgresReachable } from "./probe.js";

const SETTINGS: PostgresSettings = {
  ...readDbSettings().postgres,
  schema: "uptimizr_pg_store_test",
};

const available = await postgresReachable(SETTINGS.url);

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

describe.skipIf(!available)("postgres store", () => {
  let pg: PostgresClient;
  let duck: DuckdbClient;

  beforeAll(async () => {
    pg = createPostgresClient(SETTINGS);
    await migratePostgres(pg, SETTINGS);
    duck = await createDuckdbClient(":memory:");
    await migrateDuckdb(duck);
  });

  beforeEach(async () => {
    await pg.command(
      "TRUNCATE TABLE events, node_samples, projects, api_keys, scene_representations",
    );
  });

  afterAll(async () => {
    if (pg) {
      await pg.command(`DROP SCHEMA IF EXISTS ${SETTINGS.schema} CASCADE`);
      await pg.close();
    }
    if (duck) await duck.close();
  });

  it("re-runs migrations idempotently, also from concurrent boots", async () => {
    await Promise.all([migratePostgres(pg, SETTINGS), migratePostgres(pg, SETTINGS)]);
    await migratePostgres(pg, SETTINGS);
    const tables = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [SETTINGS.schema],
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      "agent_audit",
      "api_keys",
      "events",
      "events_daily",
      "node_samples",
      "perf_daily",
      "projects",
      "scene_regions",
      "scene_representations",
      "subscription_events",
      "subscriptions",
    ]);
  });

  it("issues and resolves API keys (hashed, never plaintext)", async () => {
    const project = await createProject(pg, "Demo");
    expect(project.orgId).toBeNull();
    expect(project.createdAt).toBeInstanceOf(Date);
    expect(await getProject(pg, project.id)).toEqual(project);
    expect(await getProject(pg, "nope")).toBeNull();

    const { key, record } = await createApiKey(pg, project.id);
    expect(key.startsWith("utk_")).toBe(true);
    expect(record).toMatchObject({
      projectId: project.id,
      capabilities: ["query"],
      label: null,
      rateLimit: null,
      revokedAt: null,
    });
    expect(record.keyPrefix).toBe(key.slice(0, record.keyPrefix.length));

    const stored = await pg.query<{ key_hash: string }>("SELECT key_hash FROM api_keys");
    expect(stored[0]?.key_hash).not.toBe(key);

    expect(await resolveApiKey(pg, key)).toEqual({
      projectId: project.id,
      keyId: record.id,
      capabilities: ["query"],
      label: null,
      rateLimit: null,
    });
    expect(await resolveApiKey(pg, "utk_unknown")).toBeNull();

    const ingest = await createApiKey(pg, project.id, { capabilities: ["ingest"] });
    expect(await resolveApiKey(pg, ingest.key)).toMatchObject({ capabilities: ["ingest"] });
  });

  it("issues an agent key with a capability set, label and per-key rate limit (#309)", async () => {
    const project = await createProject(pg, "Demo");
    const { key, record } = await createApiKey(pg, project.id, {
      // Deliberately out of canonical order — normalized on the way in.
      capabilities: ["annotate", "query:raw", "query"],
      label: "weekly-report-agent",
      rateLimit: { max: 60, windowMs: 60_000 },
    });
    expect(record.capabilities).toEqual(["query", "annotate", "query:raw"]);
    expect(await resolveApiKey(pg, key)).toEqual({
      projectId: project.id,
      keyId: record.id,
      capabilities: ["query", "annotate", "query:raw"],
      label: "weekly-report-agent",
      // `bigint` arrives as a string from node-postgres; it must come back numeric.
      rateLimit: { max: 60, windowMs: 60_000 },
    });
  });

  it("grandfathers a legacy key that predates the capability set (#309)", async () => {
    const project = await createProject(pg, "Demo");
    // A row exactly as the pre-#309 code wrote it: singular `capability` only.
    await pg.query(
      `INSERT INTO api_keys (id, project_id, key_hash, key_prefix, capability)
       VALUES ('legacy-1', $1, $2, 'utk_legacy__', 'query')`,
      [project.id, hashApiKey("utk_legacy_plaintext")],
    );
    expect(await resolveApiKey(pg, "utk_legacy_plaintext")).toEqual({
      projectId: project.id,
      keyId: "legacy-1",
      capabilities: ["query"],
      label: null,
      rateLimit: null,
    });

    // The backfill is idempotent and never clobbers an explicit set.
    await migratePostgres(pg, SETTINGS);
    const rows = await pg.query<{ capabilities: string }>(
      `SELECT capabilities FROM api_keys WHERE id = 'legacy-1'`,
    );
    expect(rows[0]?.capabilities).toBe("query");
  });

  it("records, reads and expires agent audit rows (#309)", async () => {
    const project = await createProject(pg, "Demo");
    const { record } = await createApiKey(pg, project.id);
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    for (let i = 0; i < 3; i += 1) {
      await recordAudit(pg, {
        projectId: project.id,
        keyId: record.id,
        surface: "http",
        toolOrPath: "/api/v1/meshes/top",
        params: `{"limit":${i}}`,
        rowCount: i,
        durationMs: 5 + i,
        status: 200,
        at: new Date(base + i * 60_000),
      });
    }

    const all = await listAudit(pg, project.id);
    expect(all.map((row) => row.params)).toEqual(['{"limit":2}', '{"limit":1}', '{"limit":0}']);
    expect(all[0]).toMatchObject({ keyId: record.id, surface: "http", rowCount: 2, status: 200 });
    expect(all[0]?.at.getTime()).toBe(base + 120_000);
    expect(await listAudit(pg, project.id, { limit: 1 })).toHaveLength(1);
    expect(
      (await listAudit(pg, project.id, { since: base + 60_000, until: base + 120_000 })).map(
        (row) => row.params,
      ),
    ).toEqual(['{"limit":1}']);

    await pruneAudit(pg, base + 120_000);
    expect(await listAudit(pg, project.id)).toHaveLength(1);
    // Idempotent: a second sweep over the same cutoff changes nothing.
    await pruneAudit(pg, base + 120_000);
    expect(await listAudit(pg, project.id)).toHaveLength(1);
  });

  it("ingests events and lists sessions", async () => {
    await insertEvents(pg, PARITY_EVENTS);
    const sessions = await runPostgresQuery<{ session_id: string; events: number }>(
      pg,
      buildListSessions(PID, PARITY_RANGE, postgresDialect),
    );
    expect(sessions.map((s) => s.session_id).sort()).toEqual(["s1", "s2"]);
    expect(typeof sessions[0]?.events).toBe("number");
  });

  it("returns a replay-complete session timeline (read + stream) with exact payloads", async () => {
    await insertEvents(pg, PARITY_EVENTS);
    const timeline = await getSessionEvents(pg, PID, "s1");
    const expected = PARITY_EVENTS.filter((e) => e.sessionId === "s1").sort((a, b) => a.ts - b.ts);
    // jsonb round-trips every validated event byte-for-byte in value terms.
    expect(timeline).toEqual(expected);

    const streamed: AnyEvent[] = [];
    for await (const event of streamSessionEvents(pg, PID, "s1")) streamed.push(event);
    expect(streamed).toEqual(timeline);

    const meta = await getSessionMeta(pg, PID, "s1");
    expect(meta).toMatchObject({
      sessionId: "s1",
      startedAt: "2024-06-16 10:00:00",
      scene: { cameraType: "arc-rotate" },
      user: { id: "anon-1" },
      device: { engine: "webgpu" },
    });
    expect(await getSessionMeta(pg, PID, "missing")).toBeNull();
  });

  it("splits node_transform into node_samples and merges it back into the timeline (ADR 0027)", async () => {
    await insertEvents(pg, [
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

    const counts = await runPostgresQuery<{ event_type: string }>(
      pg,
      buildEventTypeCounts(PID, PARITY_RANGE, postgresDialect),
    );
    expect(counts.some((c) => c.event_type === "node_transform")).toBe(false);

    const timeline = await getSessionEvents(pg, PID, "s1");
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
    for await (const event of streamSessionEvents(pg, PID, "s1")) streamed.push(event.type);
    expect(streamed).toEqual(timeline.map((e) => e.type));
  });

  it("stores and reads back a scene proxy, keeping the label on relabel-less upserts", async () => {
    const saved = await upsertSceneProxy(pg, PID, SCENE_PROXY, "Lobby");
    expect(saved).toMatchObject({ sceneId: "lobby", kind: "proxy", label: "Lobby", upAxis: "y" });
    expect(saved.bounds).toEqual([-1, -1, -1, 1, 1, 1]);
    expect(saved.capturedAt?.getTime()).toBe(T0);

    const again = await upsertSceneProxy(pg, PID, { ...SCENE_PROXY, contentHash: "hash-2" });
    expect(again).toMatchObject({ label: "Lobby", contentHash: "hash-2" });

    const fetched = await getSceneRepresentation(pg, PID, "lobby");
    expect(fetched?.proxy?.meshes[0]?.name).toBe("box");
    expect(await getSceneRepresentation(pg, PID, "nope")).toBeNull();

    const list = await listSceneRepresentations(pg, PID);
    expect(list).toEqual([
      expect.objectContaining({ sceneId: "lobby", label: "Lobby", contentHash: "hash-2" }),
    ]);
  });

  it("round-trips a scene's regions, replacing the set on every write", async () => {
    const entrance = {
      id: "entrance",
      label: "Entrance",
      bounds: [-5, 0, -5, 5, 3, 0] as [number, number, number, number, number, number],
      description: "Where visitors arrive.",
    };
    const counter = {
      id: "counter",
      label: "Checkout counter",
      bounds: [-1, 0, 1, 1, 2, 3] as [number, number, number, number, number, number],
    };

    const saved = await putSceneRegions(pg, PID, "lobby", [entrance, counter]);
    expect(saved.map((r) => r.regionId)).toEqual(["counter", "entrance"]);
    expect(saved.find((r) => r.regionId === "entrance")).toMatchObject({
      projectId: PID,
      sceneId: "lobby",
      label: "Entrance",
      description: "Where visitors arrive.",
    });
    expect(saved.find((r) => r.regionId === "entrance")?.bounds).toEqual([-5, 0, -5, 5, 3, 0]);
    expect(saved.find((r) => r.regionId === "counter")?.description).toBeNull();
    expect(await getSceneRegions(pg, PID, "lobby")).toEqual(saved);

    // Replace-the-set: a region left out is gone; other scenes are untouched.
    await putSceneRegions(pg, PID, "atrium", [counter]);
    const replaced = await putSceneRegions(pg, PID, "lobby", [{ ...counter, label: "Till" }]);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ regionId: "counter", label: "Till" });
    expect(await getSceneRegions(pg, PID, "atrium")).toHaveLength(1);

    expect(await listSceneRegions(pg, PID)).toEqual([
      { sceneId: "atrium", regionId: "counter", label: "Checkout counter" },
      { sceneId: "lobby", regionId: "counter", label: "Till" },
    ]);

    // An empty set clears the scene; an unregistered scene reads as empty.
    expect(await putSceneRegions(pg, PID, "lobby", [])).toEqual([]);
    expect(await getSceneRegions(pg, PID, "never-registered")).toEqual([]);
    await putSceneRegions(pg, PID, "atrium", []);
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
        // Two builders need an argument the shared bag cannot supply: the
        // per-session trajectory needs its session, and the insight bucket
        // series needs the metric it is a series *of* (and a time grain, not the
        // FPS bin width `bucket` means everywhere else).
        const opts =
          name === "buildSessionTrajectory"
            ? { session: "s1", ...baseOpts }
            : name === "buildMetricBuckets"
              ? { ...baseOpts, metric: "list_sessions", bucket: "day" }
              : baseOpts;
        it(`${name} (${variant})`, async () => {
          await insertEvents(pg, EXTENDED_EVENTS);
          const pgRows = await runPostgresQuery<Record<string, unknown>>(
            pg,
            build(PID, opts as never, postgresDialect),
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
