/**
 * Live scene-region tests for `@uptimizr/db-clickhouse` (ADR 0051 §2).
 *
 * ClickHouse has neither a transactional `DELETE` nor `ON CONFLICT`, so
 * "replace the scene's set" is expressed with `ReplacingMergeTree(version)` plus
 * `deleted = 1` tombstones in one atomic block insert, read back with `FINAL`.
 * That is engine-specific machinery the pure unit tests cannot exercise, so it
 * is proven here against a real server.
 *
 * **Skipped gracefully** when no ClickHouse server is reachable (unless
 * `CLICKHOUSE_PARITY_REQUIRED` is set, like the parity suite), so it never fails
 * a dev run without the optional scale engine. Uses a throwaway database that it
 * drops on teardown.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SceneRegion } from "@uptimizr/schema";
import { createClickhouseClient, type ClickhouseClient } from "../client.js";
import { migrateClickhouse } from "../migrations.js";
import { getSceneRegions, listSceneRegions, putSceneRegions } from "../sceneRegions.js";

const CH_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CH_USER = process.env.CLICKHOUSE_USER ?? "default";
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";
const TEST_DB = "uptimizr_ch_regions_test";

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

/** Probe `/ping` so the suite can skip when the server is unreachable. */
async function clickhouseReachable(): Promise<boolean> {
  let reason: unknown;
  try {
    const res = await fetch(`${CH_URL.replace(/\/$/, "")}/ping`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return true;
    reason = new Error(`HTTP ${res.status}`);
  } catch (error) {
    reason = error;
  }
  if (process.env.CLICKHOUSE_PARITY_REQUIRED) {
    throw new Error(
      `CLICKHOUSE_PARITY_REQUIRED is set but ClickHouse is unreachable at ${CH_URL}`,
      { cause: reason },
    );
  }
  return false;
}

const available = await clickhouseReachable();

describe.skipIf(!available)("clickhouse scene regions", () => {
  let ch: ClickhouseClient;

  beforeAll(async () => {
    const settings = {
      url: CH_URL,
      database: TEST_DB,
      username: CH_USER,
      password: CH_PASSWORD,
    };
    ch = createClickhouseClient(settings);
    await migrateClickhouse(ch, settings);
  });

  beforeEach(async () => {
    // Idempotent across local re-runs: start each case from an empty table.
    await ch.command(`TRUNCATE TABLE IF EXISTS scene_regions`);
  });

  afterAll(async () => {
    if (ch) {
      await ch.command(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await ch.close();
    }
  });

  it("round-trips a region set, ordered by region id", async () => {
    const saved = await putSceneRegions(ch, PID, "lobby", [entrance, counter]);
    expect(saved.map((r) => r.regionId)).toEqual(["counter", "entrance"]);
    expect(saved.find((r) => r.regionId === "entrance")).toMatchObject({
      projectId: PID,
      sceneId: "lobby",
      label: "Entrance",
      description: "Where visitors arrive.",
    });
    expect(saved.find((r) => r.regionId === "entrance")?.bounds).toEqual([-5, 0, -5, 5, 3, 0]);
    expect(saved.find((r) => r.regionId === "counter")?.description).toBeNull();
    expect(await getSceneRegions(ch, PID, "lobby")).toEqual(saved);
  });

  it("replaces the set — a region left out is tombstoned, not resurrected", async () => {
    await putSceneRegions(ch, PID, "lobby", [entrance, counter]);
    const replaced = await putSceneRegions(ch, PID, "lobby", [{ ...counter, label: "Till" }]);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ regionId: "counter", label: "Till" });
    // Re-read (a fresh FINAL) must not bring the dropped region back.
    expect(await getSceneRegions(ch, PID, "lobby")).toHaveLength(1);
  });

  it("accepts an empty set to clear a scene's regions", async () => {
    await putSceneRegions(ch, PID, "lobby", [entrance]);
    expect(await putSceneRegions(ch, PID, "lobby", [])).toEqual([]);
    expect(await getSceneRegions(ch, PID, "lobby")).toEqual([]);
  });

  it("scopes a replace to one scene and one project", async () => {
    await putSceneRegions(ch, PID, "lobby", [entrance]);
    await putSceneRegions(ch, PID, "atrium", [counter]);
    await putSceneRegions(ch, OTHER_PID, "lobby", [counter]);

    await putSceneRegions(ch, PID, "lobby", []);
    expect(await getSceneRegions(ch, PID, "atrium")).toHaveLength(1);
    expect(await getSceneRegions(ch, OTHER_PID, "lobby")).toHaveLength(1);
  });

  it("lists a project's whole region vocabulary, excluding tombstones", async () => {
    await putSceneRegions(ch, PID, "lobby", [entrance, counter]);
    await putSceneRegions(ch, PID, "atrium", [counter]);
    await putSceneRegions(ch, PID, "lobby", [counter]);

    expect(await listSceneRegions(ch, PID)).toEqual([
      { sceneId: "atrium", regionId: "counter", label: "Checkout counter" },
      { sceneId: "lobby", regionId: "counter", label: "Checkout counter" },
    ]);
  });

  it("returns an empty set for a scene with no regions", async () => {
    expect(await getSceneRegions(ch, PID, "never-registered")).toEqual([]);
  });
});
