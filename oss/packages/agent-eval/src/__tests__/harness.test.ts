/**
 * The harness has to be a real collector, not a stub — otherwise the bank's
 * numbers prove nothing. These tests assert it is: a seeded DuckDB store behind
 * the real Fastify app, reached through the generated tools' own `buildRequest`,
 * and closed to anyone without the run's key.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTools } from "@uptimizr/agent-core";
import { startHarness, type EvalHarness } from "../harness.js";
import { EVAL_EVENTS, EVAL_RANGE, EVAL_SUPPLEMENT_EVENTS } from "../fixtures.js";

const toolsByName = new Map(readTools.map((tool) => [tool.name, tool]));

async function call(harness: EvalHarness, name: string, args: Record<string, unknown> = {}) {
  const tool = toolsByName.get(name);
  if (!tool) throw new Error(`no such tool ${name}`);
  const { path, params } = tool.buildRequest({ ...EVAL_RANGE, ...args });
  return harness.client.get(path, params);
}

describe("the fixture-backed collector", () => {
  let harness: EvalHarness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it("seeds the parity fixtures plus the supplement", () => {
    expect(EVAL_EVENTS.length).toBeGreaterThan(EVAL_SUPPLEMENT_EVENTS.length);
    expect(EVAL_SUPPLEMENT_EVENTS.length).toBeGreaterThan(0);
  });

  it("serves the sessions the fixtures describe", async () => {
    const rows = (await call(harness, "list_sessions")) as { session_id: string }[];
    expect(rows.map((r) => r.session_id).sort()).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("computes a real aggregation over the seeded events", async () => {
    const rows = (await call(harness, "perf_summary")) as { samples: number; min_fps: number }[];
    expect(rows[0]?.samples).toBe(5);
    expect(rows[0]?.min_fps).toBe(24);
  });

  it("answers the supplement's channels, not just the parity ones", async () => {
    const xr = (await call(harness, "xr_sources")) as { source: string }[];
    expect(xr.map((r) => r.source).sort()).toEqual(["gaze", "hand", "xr-controller"]);
    const ar = (await call(harness, "ar_placement_surfaces")) as { surface: string }[];
    expect(ar.map((r) => r.surface).sort()).toEqual(["floor", "table"]);
  });

  it("resolves the registered scene proxy", async () => {
    const scene = (await call(harness, "scene_representation", { sceneId: "lobby" })) as {
      sceneId: string;
      bounds: number[];
    };
    expect(scene.sceneId).toBe("lobby");
    expect(scene.bounds).toEqual([-1, 0, -1, 11, 4, 6]);
  });

  it("surfaces a collector error rather than an empty result", async () => {
    // `mesh_uv_heatmap` requires a mesh; the route must reject the call so the
    // agent loop can see the failure and recover, not read it as "no data".
    await expect(call(harness, "mesh_uv_heatmap")).rejects.toThrow();
  });

  it("gives each run its own isolated store", async () => {
    // Two harnesses must not share state: the eval runs one per process, but a
    // shared `:memory:` database would double-count every event if they did.
    const other = await startHarness();
    try {
      // Rows tie on `count`, and SQL gives no order within a tie — compare the
      // (event_type, count) pairs as a set rather than as a sequence.
      const counts = async (h: EvalHarness): Promise<string[]> => {
        const rows = (await call(h, "event_counts")) as { event_type: string; count: number }[];
        return rows.map((r) => `${r.event_type}=${r.count}`).sort();
      };
      expect(await counts(other)).toEqual(await counts(harness));
    } finally {
      await other.close();
    }
  }, 60_000);
});
