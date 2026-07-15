import { describe, expect, it } from "vitest";
import { registerPrompts } from "../prompts.js";

interface RenderedMessage {
  role: string;
  content: { type: string; text: string };
}
type PromptCb = (args: Record<string, string | undefined>) => { messages: RenderedMessage[] };

/** Capture the prompts a `registerPrompts` call registers. */
function collect() {
  const prompts = new Map<string, { config: { argsSchema?: Record<string, unknown> }; cb: PromptCb }>();
  const server = {
    registerPrompt: (name: string, config: { argsSchema?: Record<string, unknown> }, cb: PromptCb) => {
      prompts.set(name, { config, cb });
    },
  };
  registerPrompts(server as never);
  return prompts;
}

const textOf = (cb: PromptCb, args: Record<string, string | undefined>): string => {
  const { messages } = cb(args);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.role).toBe("user");
  expect(messages[0]!.content.type).toBe("text");
  return messages[0]!.content.text;
};

describe("registerPrompts", () => {
  const prompts = collect();

  it("registers the curated analysis templates", () => {
    expect([...prompts.keys()].sort()).toEqual([
      "attention_hotspots",
      "weekly_scene_health",
      "xr_comfort_review",
    ]);
  });

  it("weekly_scene_health references the health tools and scene scope", () => {
    const cb = prompts.get("weekly_scene_health")!.cb;
    const withScene = textOf(cb, { scene: "lobby" });
    expect(withScene).toContain('scene "lobby"');
    for (const tool of ["event_counts", "timeseries", "perf_summary", "top_meshes"]) {
      expect(withScene).toContain(tool);
    }
    const allScenes = textOf(cb, {});
    expect(allScenes).toContain("all scenes");
  });

  it("attention_hotspots scopes to the given scene and its tools", () => {
    const text = textOf(prompts.get("attention_hotspots")!.cb, { scene: "gallery" });
    expect(text).toContain('scene "gallery"');
    for (const tool of ["camera_heatmap", "flow_links", "click_rays", "top_meshes"]) {
      expect(text).toContain(tool);
    }
  });

  it("xr_comfort_review references the XR tools", () => {
    const text = textOf(prompts.get("xr_comfort_review")!.cb, {});
    for (const tool of ["xr_rotation", "xr_locomotion", "xr_abandonment", "xr_sources"]) {
      expect(text).toContain(tool);
    }
  });
});
