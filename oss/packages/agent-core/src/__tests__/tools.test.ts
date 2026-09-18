import { describe, expect, it } from "vitest";
import {
  readTools,
  coreReadTools,
  selectReadTools,
  filterReadTools,
  CORE_READ_TOOL_NAMES,
} from "../tools.js";
import { registryToTools } from "../registryTools.js";

const byName = (name: string) => {
  const tool = readTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

describe("read tools catalog", () => {
  it("is the catalog generated from the metric registry", () => {
    expect(readTools.map((t) => t.name)).toEqual(registryToTools().map((t) => t.name));
    expect(readTools.length).toBe(72);
  });

  it("gives every tool an output schema", () => {
    for (const tool of readTools) expect(Object.keys(tool.outputSchema ?? {})).toEqual(["rows"]);
  });

  it("exposes uniquely named tools", () => {
    const names = readTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("only targets read (api/v1/...) paths and never collect/mutation endpoints", () => {
    for (const tool of readTools) {
      // Probe with empty args; path is what the request would GET.
      const { path } = tool.buildRequest({ sessionId: "s", sceneId: "lobby" });
      expect(path.startsWith("api/v1/")).toBe(true);
      expect(path).not.toContain("collect");
      expect(path).not.toContain("representation/put");
    }
  });

  it("omits undefined params and forwards provided ones", () => {
    const { path, params } = byName("pointer_heatmap").buildRequest({
      bins: 50,
      scene: "lobby",
    });
    expect(path).toBe("api/v1/heatmaps/pointer");
    expect(params.bins).toBe(50);
    expect(params.scene).toBe("lobby");
    expect(params.since).toBeUndefined();
    expect(params.source).toBeUndefined();
  });

  it("builds a session-scoped path and encodes the id", () => {
    const { path } = byName("session_meta").buildRequest({ sessionId: "a/b c" });
    expect(path).toBe("api/v1/sessions/a%2Fb%20c/meta");
  });

  it("maps the funnel tool, forwarding steps and camera mode", () => {
    const { path, params } = byName("funnel").buildRequest({
      steps: '[{"type":"scene_change"}]',
      scene: "lobby",
      cameraMode: "first-person",
    });
    expect(path).toBe("api/v1/funnel");
    expect(params.steps).toBe('[{"type":"scene_change"}]');
    expect(params.scene).toBe("lobby");
    expect(params.cameraMode).toBe("first-person");
  });

  it("maps aggregate desire-line paths with cellSize", () => {
    const { path, params } = byName("aggregate_paths").buildRequest({ cellSize: 2, limit: 100 });
    expect(path).toBe("api/v1/paths");
    expect(params.cellSize).toBe(2);
    expect(params.limit).toBe(100);
  });

  it("maps the XR rotation tool, forwarding rapidTurn", () => {
    const { path, params } = byName("xr_rotation").buildRequest({ rapidTurn: 1.5, session: "s1" });
    expect(path).toBe("api/v1/xr/rotation");
    expect(params.rapidTurn).toBe(1.5);
    expect(params.session).toBe("s1");
  });

  it("maps each documented read endpoint to a tool", () => {
    const paths = readTools.map((t) => t.buildRequest({ sessionId: "s", sceneId: "x" }).path);
    expect(paths).toContain("api/v1/sessions");
    expect(paths).toContain("api/v1/heatmaps/world");
    expect(paths).toContain("api/v1/heatmaps/camera");
    expect(paths).toContain("api/v1/heatmaps/click-rays");
    expect(paths).toContain("api/v1/heatmaps/flow");
    expect(paths).toContain("api/v1/meshes/top");
    expect(paths).toContain("api/v1/perf");
    expect(paths).toContain("api/v1/scenes");
    expect(paths).toContain("api/v1/timeseries");
    expect(paths).toContain("api/v1/event-counts");
    // #194 — new read tools (ADR 0037 / 0038 / 0046 / 0048).
    expect(paths).toContain("api/v1/funnel");
    expect(paths).toContain("api/v1/paths");
    expect(paths).toContain("api/v1/rendering-technology");
    expect(paths).toContain("api/v1/xr/rotation");
    expect(paths).toContain("api/v1/xr/sources");
    expect(paths).toContain("api/v1/xr/abandonment");
    expect(paths).toContain("api/v1/xr/locomotion");
  });
});

describe("core read-tool subset", () => {
  it("is a filtered view of readTools (same object identity, never redefined)", () => {
    for (const tool of coreReadTools) {
      // Each core tool MUST be the very same definition object from readTools —
      // schema lives once (ADR): the core set filters, it never re-declares.
      expect(readTools).toContain(tool);
    }
  });

  it("covers the common single-step tools and excludes the heavy ones", () => {
    const names = coreReadTools.map((t) => t.name);
    // Same membership as the name list (order follows readTools, so compare sets).
    expect(new Set(names)).toEqual(new Set(CORE_READ_TOOL_NAMES));
    expect(names.length).toBe(CORE_READ_TOOL_NAMES.length);
    for (const expected of [
      "list_sessions",
      "list_scenes",
      "top_meshes",
      "perf_summary",
      "event_counts",
      "timeseries",
      "camera_heatmap",
    ]) {
      expect(names).toContain(expected);
    }
    // Multi-arg / niche tools stay out of the small-model core surface.
    expect(names).not.toContain("funnel");
    expect(names).not.toContain("xr_locomotion");
    expect(coreReadTools.length).toBeLessThan(readTools.length);
  });

  it("selectReadTools returns the core subset for 'core' and the full catalog for 'full'", () => {
    expect(selectReadTools("core")).toBe(coreReadTools);
    expect(selectReadTools("full")).toBe(readTools);
  });
});

describe("filterReadTools", () => {
  it("narrows the catalog to the named tools, preserving catalog order and identity", () => {
    const picked = filterReadTools(["perf_summary", "dead_clicks"]);
    expect(picked.map((t) => t.name)).toEqual(["dead_clicks", "perf_summary"]);
    for (const tool of picked) expect(readTools).toContain(tool);
  });

  it("ignores names no longer in the catalog rather than throwing", () => {
    expect(filterReadTools(["top_meshes", "retired_metric"]).map((t) => t.name)).toEqual([
      "top_meshes",
    ]);
    expect(filterReadTools([])).toHaveLength(0);
  });
});
