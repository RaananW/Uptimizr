import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent, PanelSpecV1, SceneProxy, Subscription } from "@uptimizr/schema";
import { buildEventsDaily, duckdbDialect } from "../index.js";
import { recordAudit } from "../duckdb/audit.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { getSessionEvents, getSessionMeta, insertEvents, pruneEvents } from "../duckdb/events.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { createPanelSpec } from "../duckdb/panelSpecs.js";
import { createApiKey, createProject } from "../duckdb/projects.js";
import {
  createAnnotation,
  createSavedAnalysis,
  putGlossaryEntry,
} from "../duckdb/projectMetadata.js";
import { runDuckdbQuery } from "../duckdb/queries.js";
import { putSceneRegions } from "../duckdb/sceneRegions.js";
import { upsertSceneProxy } from "../duckdb/sceneRegistry.js";
import { createSubscription, recordSubscriptionEvent } from "../duckdb/subscriptions.js";

/**
 * The `EVENT_RETENTION_DAYS` delete on the OSS DuckDB store (ADR 0052): rows
 * before the cutoff go, the rest stay, and nothing but raw events is touched.
 */

const DAY = 24 * 60 * 60 * 1000;
const CUTOFF = Date.UTC(2024, 5, 16, 0, 0, 0);
const OLD = CUTOFF - 2 * DAY;
const NEW = CUTOFF + 2 * DAY;
const author = { authorKind: "user", authorKeyId: "key_1" } as const;

function ev(type: string, ts: number, extra: Record<string, unknown> = {}): AnyEvent {
  return {
    type,
    projectId: "p1",
    sessionId: "s1",
    ts,
    sdkVersion: "0.1.0",
    sceneId: "lobby",
    ...extra,
  } as AnyEvent;
}

function nodeSample(ts: number): AnyEvent {
  return ev("node_transform", ts, {
    nodeId: "door",
    position: [1, 2, 3],
    rotation: [0, 0, 0, 1],
  });
}

const PROXY: SceneProxy = {
  version: 1,
  sceneId: "lobby",
  kind: "aabb",
  bounds: [-1, -1, -1, 1, 1, 1],
  upAxis: "y",
  unitScale: 1,
  meshes: [{ name: "box", aabb: [-1, -1, -1, 1, 1, 1] }],
  meshCount: 1,
  contentHash: "hash-1",
  capturedAt: OLD,
  sdkVersion: "0.1.0",
};

const SUBSCRIPTION = {
  name: "FPS drop",
  metric: "perf_summary",
  filters: { scene: "lobby" },
  evaluate: { every: "5m", window: "1h" },
  predicate: { kind: "threshold", column: "p50_fps", op: "<", value: 30 },
  cooldown: "1h",
  delivery: [{ kind: "sse" }],
  enabled: true,
} as Subscription;

const PANEL = {
  v: 1,
  title: "Top meshes",
  chart: "bar",
  span: 1,
  query: { v: 1, metric: "top_meshes", range: "inherit", limit: 10 },
} as PanelSpecV1;

/** One row in every non-event table, so a stray delete cannot go unnoticed. */
async function seedEverythingElse(db: DuckdbClient): Promise<void> {
  const project = await createProject(db, "Demo");
  const { record } = await createApiKey(db, project.id);
  await recordAudit(db, {
    projectId: project.id,
    keyId: record.id,
    surface: "http",
    toolOrPath: "/api/v1/sessions",
    params: "{}",
    durationMs: 1,
    status: 200,
    at: new Date(OLD),
  });
  await upsertSceneProxy(db, project.id, PROXY, "Lobby");
  await putSceneRegions(db, project.id, "lobby", [
    { id: "door", label: "Door", bounds: [0, 0, 0, 1, 1, 1] },
  ]);
  await createAnnotation(db, project.id, {
    ...author,
    annotation: { targetKind: "session", targetId: "s1", text: "odd session" },
  });
  await putGlossaryEntry(db, project.id, { entry: { term: "TTFR", meaning: "first render" } });
  await createSavedAnalysis(db, project.id, {
    ...author,
    analysis: { title: "Lobby", query: { metric: "perf_summary" }, conclusion: "fine" },
  });
  await createPanelSpec(db, project.id, { ...author, spec: PANEL });
  const subscription = await createSubscription(db, project.id, SUBSCRIPTION);
  await recordSubscriptionEvent(db, {
    subscriptionId: subscription.id,
    projectId: project.id,
    at: new Date(OLD),
    payload: { seq: 1 },
  });
}

/** Row count of every base table in the store. */
async function tableCounts(db: DuckdbClient): Promise<Record<string, number>> {
  const tables = await db.all<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE'`,
  );
  const counts: Record<string, number> = {};
  for (const { table_name: table } of tables) {
    const rows = await db.all<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`);
    counts[table] = rows[0]!.n;
  }
  return counts;
}

describe("duckdb event retention", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("deletes rows older than the cutoff and keeps the rest", async () => {
    await insertEvents(db, [
      ev("frame_perf", OLD, { fps: 30 }),
      ev("frame_perf", CUTOFF - 1, { fps: 31 }),
      ev("frame_perf", CUTOFF, { fps: 32 }),
      ev("frame_perf", NEW, { fps: 33 }),
    ]);

    await pruneEvents(db, CUTOFF);

    const left = await getSessionEvents(db, "p1", "s1");
    // `ts < cutoff`: the row exactly on the cutoff survives.
    expect(left.map((e) => e.ts)).toEqual([CUTOFF, NEW]);
  });

  it("prunes node_transform samples too, which live in their own table", async () => {
    await insertEvents(db, [nodeSample(OLD), nodeSample(CUTOFF - 1), nodeSample(NEW)]);
    expect((await tableCounts(db)).node_samples).toBe(3);

    await pruneEvents(db, CUTOFF);

    expect((await tableCounts(db)).node_samples).toBe(1);
    expect((await getSessionEvents(db, "p1", "s1")).map((e) => e.ts)).toEqual([NEW]);
  });

  it("covers every project, not just one", async () => {
    await insertEvents(db, [
      ev("frame_perf", OLD, { fps: 30 }),
      ev("frame_perf", OLD, { fps: 30, projectId: "p2" }),
    ]);

    await pruneEvents(db, CUTOFF);

    expect((await tableCounts(db)).events).toBe(0);
  });

  it("is idempotent", async () => {
    await insertEvents(db, [
      ev("frame_perf", OLD, { fps: 30 }),
      ev("frame_perf", NEW, { fps: 33 }),
    ]);

    await pruneEvents(db, CUTOFF);
    await pruneEvents(db, CUTOFF);

    expect((await tableCounts(db)).events).toBe(1);
  });

  it("touches only the raw event tables, even for metadata older than the cutoff", async () => {
    await seedEverythingElse(db);
    await insertEvents(db, [ev("frame_perf", OLD, { fps: 30 }), nodeSample(OLD)]);
    const before = await tableCounts(db);
    // Guard against a vacuous pass: every table holds a row to lose.
    expect(Object.entries(before).filter(([, n]) => n === 0)).toEqual([]);

    // A cutoff past now, so anything dated would qualify if it were selected.
    await pruneEvents(db, Date.now() + DAY);

    expect(await tableCounts(db)).toEqual({ ...before, events: 0, node_samples: 0 });
  });

  it("removes the purged days from aggregates", async () => {
    await insertEvents(db, [
      ev("frame_perf", OLD, { fps: 30 }),
      ev("frame_perf", NEW, { fps: 33 }),
    ]);
    const range = { since: OLD - DAY, until: NEW + DAY };
    const days = () =>
      runDuckdbQuery<{ day: string }>(db, buildEventsDaily("p1", range, duckdbDialect));
    expect(await days()).toHaveLength(2);

    await pruneEvents(db, CUTOFF);

    expect(await days()).toHaveLength(1);
  });

  it("leaves a session straddling the cutoff with only its newer events", async () => {
    await insertEvents(db, [
      ev("session_start", OLD, { device: { engine: "webgpu" } }),
      ev("frame_perf", NEW, { fps: 33 }),
    ]);

    await pruneEvents(db, CUTOFF);

    expect((await getSessionEvents(db, "p1", "s1")).map((e) => e.type)).toEqual(["frame_perf"]);
    // Its descriptor came from `session_start`, so that is gone with it.
    expect(await getSessionMeta(db, "p1", "s1")).toBeNull();
  });
});

/**
 * The failure no `:memory:` store can show (ADR 0052). Rows replayed from a WAL
 * by a process that closes without an explicit `CHECKPOINT` are missing from the
 * ART index afterwards, and deleting one is a FATAL that invalidates the whole
 * instance. The unclean exit is staged with `disable_checkpoint_on_shutdown`,
 * which leaves the WAL behind.
 */
describe("duckdb event retention on a file after an unclean exit", () => {
  let dir: string;
  let file: string;
  const open = async (): Promise<DuckdbClient> => {
    const db = await createDuckdbClient(file);
    await migrateDuckdb(db);
    return db;
  };
  const NODE_OLD = nodeSample(OLD);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "uptimizr-retention-"));
    file = join(dir, "store.duckdb");

    const crashing = await open();
    await crashing.run("PRAGMA disable_checkpoint_on_shutdown");
    await insertEvents(crashing, [
      ev("frame_perf", OLD, { fps: 30 }),
      ev("frame_perf", NEW, { fps: 33 }),
      NODE_OLD,
    ]);
    await crashing.close();

    // A tool, not the collector: it replays the WAL and never checkpoints, where
    // the collector's own boot would (`migrateDuckdb`) and so stay safe.
    await (await createDuckdbClient(file)).close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("proves the staged file really does break a plain DELETE", async () => {
    const db = await open();
    await expect(
      db.run(`DELETE FROM events WHERE ts < make_timestamp(${CUTOFF * 1000})`),
    ).rejects.toThrow(/Failed to delete all rows from index/);
    // Invalidated: this is what the sweep must never do to a running collector.
    await expect(db.all("SELECT 1")).rejects.toThrow(/invalidated/);
    await db.close().catch(() => {});
  });

  it("prunes it, and leaves the store working and the indexes in place", async () => {
    const db = await open();

    await pruneEvents(db, CUTOFF);

    const counts = await tableCounts(db);
    expect(counts.events).toBe(1);
    expect(counts.node_samples).toBe(0);

    await insertEvents(db, [ev("frame_perf", NEW + 1, { fps: 34 })]);
    expect((await getSessionEvents(db, "p1", "s1")).map((e) => e.ts)).toEqual([NEW, NEW + 1]);

    const indexes = await db.all<{ index_name: string }>(
      `SELECT index_name FROM duckdb_indexes() WHERE table_name IN ('events', 'node_samples')`,
    );
    expect(indexes.map((row) => row.index_name).sort()).toEqual([
      "events_project_type_ts_idx",
      "node_samples_session_node_child_ts_idx",
      "node_samples_session_node_ts_idx",
    ]);
    await db.close();
  });

  it("survives repeated sweeps across restarts, clean or not", async () => {
    let db = await open();
    await pruneEvents(db, CUTOFF);
    await insertEvents(db, [ev("frame_perf", OLD + 1, { fps: 31 })]);
    await db.run("PRAGMA disable_checkpoint_on_shutdown");
    await db.close();

    await (await createDuckdbClient(file)).close();

    db = await open();
    await pruneEvents(db, CUTOFF);
    await pruneEvents(db, CUTOFF);
    expect((await tableCounts(db)).events).toBe(1);
    await db.close();

    db = await open();
    expect((await getSessionEvents(db, "p1", "s1")).map((e) => e.ts)).toEqual([NEW]);
    await db.close();
  });
});
