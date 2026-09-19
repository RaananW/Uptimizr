import { z } from "zod";
import { describe, expect, it } from "vitest";
import { allMetrics, metricCapability } from "@uptimizr/metrics";
import {
  readTools,
  rawTools,
  coreReadTools,
  selectReadTools,
  filterReadTools,
  CORE_READ_TOOL_NAMES,
} from "../tools.js";
import { registryToTools } from "../registryTools.js";
import { QUERY_TOOL_NAME, queryTool } from "../queryTool.js";

const byName = (name: string) => {
  const tool = readTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

describe("read tools catalog", () => {
  it("is the catalog generated from the metric registry, plus the query tool", () => {
    // The `query` half of the generated catalog — every tool whose endpoint
    // needs nothing more than the ordinary read capability (ADR 0051 §7) — plus
    // the one tool that is not per-metric, the query DSL (ADR 0051 §3).
    const queryMetrics = allMetrics().filter((m) => metricCapability(m) === "query");
    expect(readTools.map((t) => t.name)).toEqual([
      ...registryToTools(queryMetrics).map((t) => t.name),
      QUERY_TOOL_NAME,
    ]);
    expect(readTools.length).toBe(70);
  });

  it("splits the query:raw tools out into their own catalog", () => {
    // `session_narrative` must never be in `readTools`: a host registers it only
    // after confirming the key holds `query:raw` (ADR 0051 §7), because a tool
    // that always answers 403 is worse than no tool at all.
    expect(readTools.map((t) => t.name)).not.toContain("session_narrative");
    expect(rawTools.map((t) => t.name)).toEqual(["session_narrative"]);
    for (const tool of rawTools) {
      expect(readTools.some((read) => read.name === tool.name)).toBe(false);
      expect(Object.keys(z.toJSONSchema(tool.outputSchema!).properties ?? {})).toContain("rows");
    }
  });

  it("gives the narrative tool its registry parameters", () => {
    const narrative = rawTools.find((tool) => tool.name === "session_narrative")!;
    expect(Object.keys(narrative.inputSchema).sort()).toEqual(
      ["sessionId", "minDwellMs", "fpsThreshold", "maxEntries", "format"].sort(),
    );
    expect(narrative.buildRequest({ sessionId: "s 1", maxEntries: 50 })).toEqual({
      path: "api/v1/sessions/s%201/narrative",
      // `format` defaults to `table` for every generated tool that declares it
      // (#336); the narrative route serves that envelope too.
      params: { minDwellMs: undefined, fpsThreshold: undefined, maxEntries: 50, format: "table" },
    });
  });

  it("gives every tool an object output schema", () => {
    for (const tool of readTools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(z.toJSONSchema(tool.outputSchema!).type, tool.name).toBe("object");
    }
    // The DSL tool's shape is chosen by its `format`, so it advertises the
    // single `result` key (ADR 0051 §3) and supplies its own wrapper.
    expect(Object.keys(z.toJSONSchema(queryTool.outputSchema!).properties ?? {})).toEqual([
      "result",
    ]);
    expect(queryTool.structuredContent?.([1, 2])).toEqual({ result: [1, 2] });
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
