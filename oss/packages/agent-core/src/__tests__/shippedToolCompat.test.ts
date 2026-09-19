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
import { readTools } from "../tools.js";
import { DEFAULT_TOOL_FORMAT, registryToTools } from "../registryTools.js";
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
 *
 * `format` (ADR 0051 §2) is on every aggregate tool, because the registry
 * declares it on every metric served on a querystring endpoint — the two
 * resource reads (`session_meta`, `scene_representation`) take no querystring
 * and so do not gain it. It stays **optional**, so an old caller that omits it
 * is still valid — but what it then gets back has deliberately changed: since
 * #336 the tools apply `format=table`, wrapping the same rows in the `meta`
 * envelope instead of returning them bare. That is a behaviour change for a
 * caller that reads `structuredContent` (a `minor` release), not a schema
 * change: the arguments below are still exactly the arguments that shipped.
 * It is pinned as its own assertion so it cannot happen silently again.
 */
const EXPECTED_ADDED_PARAMS: Readonly<Record<string, readonly string[]>> = {
  list_sessions: ["bins", "cameraMode", "format"],
  pointer_heatmap: ["limit", "cameraMode", "format"],
  world_heatmap: ["cameraMode", "region", "format"],
  camera_heatmap: ["limit", "cameraMode", "format"],
  click_rays: ["format"],
  flow_links: ["cameraMode", "cellSize", "groupByOrigin", "originVoxel", "format"],
  top_meshes: ["bins", "format"],
  perf_summary: ["bins", "limit", "format"],
  list_scenes: ["format"],
  timeseries: ["format"],
  event_counts: ["format"],
  session_meta: [],
  scene_representation: [],
  funnel: ["format"],
  aggregate_paths: ["format"],
  rendering_technology: ["bins", "limit", "format"],
  xr_rotation: ["format"],
  xr_sources: ["bins", "format"],
  xr_abandonment: ["bins", "format"],
  xr_locomotion: ["bins", "format"],
};

describe("shipped tool compatibility", () => {
  it("freezes exactly the 20 tools that shipped before the registry", () => {
    expect(Object.keys(frozen)).toHaveLength(20);
  });

  it("defaults the result envelope to table without requiring the argument (#336)", () => {
    // The deliberate behaviour change. `format` is advertised with a JSON
    // Schema `default` rather than a Zod `.default()`, which would have made
    // it a *required* property in the schema's output view and forced every
    // model to name an envelope on every call.
    expect(DEFAULT_TOOL_FORMAT).toBe("table");
    for (const [name, schema] of generated) {
      const format = schema.properties?.format as { default?: string } | undefined;
      if (format == null) {
        // Only the two resource reads, which take no querystring at all.
        expect(name, name).toMatch(/^(session_meta|scene_representation)$/);
        continue;
      }
      expect(format.default, name).toBe(DEFAULT_TOOL_FORMAT);
      expect(schema.required ?? [], name).not.toContain("format");
    }
  });

  it("sends that default on the wire, so the collector default stays full", () => {
    const tools = new Map(registryToTools().map((tool) => [tool.name, tool]));
    expect(tools.get("top_meshes")?.buildRequest({}).params.format).toBe("table");
    // An explicit choice still wins, and `full` is still reachable.
    expect(tools.get("top_meshes")?.buildRequest({ format: "full" }).params.format).toBe("full");
    // A resource read never gains the parameter.
    expect(tools.get("session_meta")?.buildRequest({ sessionId: "s1" }).params.format).toBe(
      undefined,
    );
  });

  it("keeps every shipped tool name in the generated catalog", () => {
    for (const shipped of Object.keys(frozen)) expect(generated.has(shipped)).toBe(true);
  });

  it("is the catalog the package actually exports, plus the query tool", () => {
    // `generated` is the per-metric catalog; `readTools` appends the one tool
    // that is not per-metric, the query DSL (ADR 0051 §3).
    expect(readTools.map((tool) => tool.name)).toEqual([...generated.keys(), "query"]);
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
