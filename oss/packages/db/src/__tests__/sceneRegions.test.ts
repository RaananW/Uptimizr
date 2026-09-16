import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SceneRegion } from "@uptimizr/schema";
import { DUCKDB_MIGRATIONS } from "../duckdb/migrations.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { getSceneRegions, listSceneRegions, putSceneRegions } from "../duckdb/sceneRegions.js";

/**
 * Scene-region storage on the OSS DuckDB store (ADR 0051 §2 / sketch §B.2):
 * the replace-the-set write, the per-scene read, the project-wide listing, and
 * the isolation guarantees the collector relies on (per project, per scene).
 */

const PID = "p1";
const OTHER_PID = "p2";

const entrance: SceneRegion = {
  id: "entrance",
  label: "Entrance",
  bounds: [-5, 0, -5, 5, 3, 0],
  description: "Where visitors arrive.",
};
const counter: SceneRegion = {
  id: "counter",
  label: "Checkout counter",
  bounds: [-1, 0, 1, 1, 2, 3],
};

describe("duckdb scene regions", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("round-trips a region set, ordered by region id", async () => {
    const saved = await putSceneRegions(db, PID, "lobby", [entrance, counter]);
    expect(saved.map((r) => r.regionId)).toEqual(["counter", "entrance"]);

    const read = await getSceneRegions(db, PID, "lobby");
    expect(read).toEqual(saved);
    const stored = read.find((r) => r.regionId === "entrance")!;
    expect(stored).toMatchObject({
      projectId: PID,
      sceneId: "lobby",
      label: "Entrance",
      description: "Where visitors arrive.",
    });
    expect(stored.bounds).toEqual([-5, 0, -5, 5, 3, 0]);
    expect(stored.updatedAt).toBeInstanceOf(Date);
    // An omitted description is stored as SQL NULL, surfaced as `null`.
    expect(read.find((r) => r.regionId === "counter")?.description).toBeNull();
  });

  it("replaces the whole set — a region left out is removed", async () => {
    await putSceneRegions(db, PID, "lobby", [entrance, counter]);
    const replaced = await putSceneRegions(db, PID, "lobby", [{ ...counter, label: "Till" }]);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ regionId: "counter", label: "Till" });
    expect(await getSceneRegions(db, PID, "lobby")).toHaveLength(1);
  });

  it("accepts an empty set to clear a scene's regions", async () => {
    await putSceneRegions(db, PID, "lobby", [entrance]);
    expect(await putSceneRegions(db, PID, "lobby", [])).toEqual([]);
    expect(await getSceneRegions(db, PID, "lobby")).toEqual([]);
  });

  it("stores overlapping regions — membership is every containing box", async () => {
    const hall: SceneRegion = { id: "hall", label: "Hall", bounds: [-10, 0, -10, 10, 5, 10] };
    const saved = await putSceneRegions(db, PID, "lobby", [hall, counter]);
    expect(saved).toHaveLength(2);
  });

  it("scopes a replace to one scene and one project", async () => {
    await putSceneRegions(db, PID, "lobby", [entrance]);
    await putSceneRegions(db, PID, "atrium", [counter]);
    await putSceneRegions(db, OTHER_PID, "lobby", [counter]);

    // Replacing `lobby` leaves the other scene and the other project untouched.
    await putSceneRegions(db, PID, "lobby", []);
    expect(await getSceneRegions(db, PID, "atrium")).toHaveLength(1);
    expect(await getSceneRegions(db, OTHER_PID, "lobby")).toHaveLength(1);
  });

  it("returns an empty set for a scene with no regions", async () => {
    expect(await getSceneRegions(db, PID, "never-registered")).toEqual([]);
  });

  it("lists a project's whole region vocabulary without the boxes", async () => {
    await putSceneRegions(db, PID, "lobby", [entrance, counter]);
    await putSceneRegions(db, PID, "atrium", [counter]);
    await putSceneRegions(db, OTHER_PID, "lobby", [entrance]);

    expect(await listSceneRegions(db, PID)).toEqual([
      { sceneId: "atrium", regionId: "counter", label: "Checkout counter" },
      { sceneId: "lobby", regionId: "counter", label: "Checkout counter" },
      { sceneId: "lobby", regionId: "entrance", label: "Entrance" },
    ]);
  });
});

describe("DUCKDB_MIGRATIONS", () => {
  it("creates scene_regions idempotently, keyed by (project, scene, region)", () => {
    const migration = DUCKDB_MIGRATIONS.find((m) => m.id === "0038_scene_regions");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS scene_regions");
    expect(migration?.sql).toContain("PRIMARY KEY (project_id, scene_id, region_id)");
  });

  it("keeps ids unique and sorted (forward-only, appended never edited — ADR 0007)", () => {
    const ids = DUCKDB_MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
