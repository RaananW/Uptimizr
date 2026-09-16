/**
 * Backward-compatibility gate for the generated tool catalog (design sketch §A.4).
 *
 * The catalog used to be a hand-written array of 20 tools. It is now generated
 * from the `@uptimizr/db` metric registry, and an MCP client that calls
 * `top_meshes` (or any of the other 19) with the arguments it learned from the
 * old schema must keep working. `fixtures/shippedToolSchemas.json` is the
 * **frozen** JSON Schema of those 20 tools, captured from the hand-written array
 * immediately before it was deleted; nothing in it may change.
 *
 * The generated catalog is asserted to be a *superset*: same names, every
 * shipped parameter present and identical, the same required parameters, and
 * any parameter the generator adds must be optional (an old caller that omits it
 * is still valid). The widening is pinned below so it stays reviewable.
 */

import { describe, expect, it } from "vitest";
import { registryToTools } from "../registryTools.js";
import { toToolSchemas } from "../loop.js";
import shippedSchemas from "./fixtures/shippedToolSchemas.json" with { type: "json" };

/** The frozen JSON Schema of one shipped tool's arguments. */
interface ArgumentSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

const frozen = shippedSchemas as unknown as Record<string, ArgumentSchema>;

const generated = new Map(
  toToolSchemas(registryToTools()).map((tool) => [
    tool.name,
    tool.parameters as unknown as ArgumentSchema,
  ]),
);

/**
 * Parameters the registry-generated tool accepts that the hand-written one did
 * not. These are filters the collector endpoint already supported but the
 * hand-written catalog never surfaced; every one of them is optional, so no
 * existing call changes meaning. Pinned so a future widening is a deliberate,
 * reviewed edit rather than a silent one.
 */
const EXPECTED_ADDED_PARAMS: Readonly<Record<string, readonly string[]>> = {
  list_sessions: ["bins", "cameraMode"],
  pointer_heatmap: ["limit", "cameraMode"],
  world_heatmap: ["cameraMode", "region"],
  camera_heatmap: ["limit", "cameraMode"],
  click_rays: [],
  flow_links: ["cameraMode", "cellSize", "groupByOrigin", "originVoxel"],
  top_meshes: ["bins"],
  perf_summary: ["bins", "limit"],
  list_scenes: [],
  timeseries: [],
  event_counts: [],
  session_meta: [],
  scene_representation: [],
  funnel: [],
  aggregate_paths: [],
  rendering_technology: ["bins", "limit"],
  xr_rotation: [],
  xr_sources: ["bins"],
  xr_abandonment: ["bins"],
  xr_locomotion: ["bins"],
};

describe("shipped tool compatibility", () => {
  it("freezes exactly the 20 tools that shipped before the registry", () => {
    expect(Object.keys(frozen)).toHaveLength(20);
  });

  it("keeps every shipped tool name in the generated catalog", () => {
    for (const shipped of Object.keys(frozen)) expect(generated.has(shipped)).toBe(true);
  });

  // Removed by the migration commit, once `readTools` IS the generated catalog:
  // until then it proves the frozen fixture really is the hand-written array.
  it("froze the hand-written catalog faithfully", async () => {
    const { readTools } = await import("../tools.js");
    const live = new Map(toToolSchemas(readTools).map((t) => [t.name, t.parameters]));
    for (const [name, schema] of Object.entries(frozen)) expect(live.get(name)).toEqual(schema);
    expect(live.size).toBe(Object.keys(frozen).length);
  });

  for (const [name, expected] of Object.entries(frozen)) {
    describe(name, () => {
      const actual = generated.get(name);

      it("is generated with an identical definition for every shipped parameter", () => {
        expect(actual).toBeDefined();
        for (const [param, schema] of Object.entries(expected.properties ?? {})) {
          expect(actual?.properties?.[param], `${name}.${param}`).toEqual(schema);
        }
      });

      it("requires exactly the parameters it always required", () => {
        expect([...(actual?.required ?? [])].sort()).toEqual([...(expected.required ?? [])].sort());
      });

      it("only widens with optional parameters", () => {
        const before = new Set(Object.keys(expected.properties ?? {}));
        const added = Object.keys(actual?.properties ?? {}).filter((p) => !before.has(p));
        expect(added.sort()).toEqual([...(EXPECTED_ADDED_PARAMS[name] ?? [])].sort());
        for (const param of added) expect(actual?.required ?? []).not.toContain(param);
      });

      it("rejects unknown arguments, as it always did", () => {
        expect(actual?.additionalProperties).toBe(expected.additionalProperties);
      });
    });
  }
});
