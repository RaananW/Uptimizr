import { describe, expect, it } from "vitest";
import { AGENT_SKILLS, AGENT_SKILL_NAMES, getAgentSkill } from "@uptimizr/agent-core";
import { registerPrompts } from "../prompts.js";

interface RenderedMessage {
  role: string;
  content: { type: string; text: string };
}
type PromptCb = (args: Record<string, string | undefined>) => { messages: RenderedMessage[] };

/** Just enough of a Zod schema to assert one argument's optionality. */
interface ZodLike {
  safeParse(value: unknown): { success: boolean };
}

/** Capture the prompts a `registerPrompts` call registers. */
function collect() {
  const prompts = new Map<
    string,
    { config: { argsSchema?: Record<string, unknown> }; cb: PromptCb }
  >();
  const server = {
    registerPrompt: (
      name: string,
      config: { argsSchema?: Record<string, unknown> },
      cb: PromptCb,
    ) => {
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

/** Where the rendered text first names one of the skill's own tools. */
function firstToolMention(text: string, skillName: string): number {
  const positions = getAgentSkill(skillName)!
    .tools.map((tool) => text.indexOf("`" + tool + "`"))
    .filter((index) => index >= 0);
  return positions.length === 0 ? -1 : Math.min(...positions);
}

describe("registerPrompts", () => {
  const prompts = collect();

  it("registers one template per packaged skill", () => {
    expect([...prompts.keys()].sort()).toEqual([...AGENT_SKILL_NAMES].sort());
  });

  it("weekly_scene_health references the health tools and scene scope", () => {
    const cb = prompts.get("weekly_scene_health")!.cb;
    const withScene = textOf(cb, { scene: "lobby" });
    expect(withScene).toContain('scene "lobby"');
    for (const tool of [
      "event_counts",
      "timeseries",
      "perf_summary",
      "top_meshes",
      // --- anomalies (#306): the prompt must put a date on whatever moved.
      "insight_anomalies",
    ]) {
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

  it("xr_comfort_audit references the XR tools", () => {
    const text = textOf(prompts.get("xr_comfort_audit")!.cb, {});
    for (const tool of ["xr_rotation", "xr_locomotion", "xr_abandonment", "xr_sources"]) {
      expect(text).toContain(tool);
    }
  });

  it("offers the two new methodologies with their own tool sets (#316)", () => {
    const conversion = textOf(prompts.get("conversion_investigation")!.cb, {});
    for (const tool of ["funnel", "load_bounce_funnel", "dead_clicks", "mesh_reachability"]) {
      expect(conversion).toContain(tool);
    }
    const triage = textOf(prompts.get("performance_regression_triage")!.cb, { scene: "lobby" });
    expect(triage).toContain('scene "lobby"');
    for (const tool of ["insight_movers", "jank_rate", "compile_stalls", "perf_by_device"]) {
      expect(triage).toContain(tool);
    }
  });

  it("declares every skill argument on the template, required flags included", () => {
    for (const skill of AGENT_SKILLS) {
      const schema = prompts.get(skill.name)!.config.argsSchema ?? {};
      expect(Object.keys(schema).sort(), skill.name).toEqual(
        skill.args.map((arg) => arg.name).sort(),
      );
    }
    // The one scene-scoped skill: its argument must stay required, or a client
    // will send an unscoped request the method cannot answer.
    const required = prompts.get("attention_hotspots")!.config.argsSchema!.scene as ZodLike;
    expect(required.safeParse(undefined).success).toBe(false);
    const optional = prompts.get("weekly_scene_health")!.config.argsSchema!.scene as ZodLike;
    expect(optional.safeParse(undefined).success).toBe(true);
  });

  it("tells every template to read the project context first (ADR 0051 §5)", () => {
    for (const [name, prompt] of prompts) {
      const text = textOf(prompt.cb, { scene: "lobby" });
      expect(text, name).toContain("uptimizr://context");
      // …and before it names any tool, so the agent orients before it asks.
      const firstTool = firstToolMention(text, name);
      expect(firstTool, name).toBeGreaterThan(-1);
      expect(text.indexOf("uptimizr://context"), name).toBeLessThan(firstTool);
    }
  });
});
