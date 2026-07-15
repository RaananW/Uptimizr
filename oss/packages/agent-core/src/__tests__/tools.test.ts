import { describe, expect, it } from "vitest";
import { readTools } from "../tools.js";

const byName = (name: string) => {
  const tool = readTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

describe("read tools catalog", () => {
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
