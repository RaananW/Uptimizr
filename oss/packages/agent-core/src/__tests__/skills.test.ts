/**
 * The curated agent skills (ADR 0050 §7, ADR 0051 §6).
 *
 * These are the same three investigations `@uptimizr/mcp` exposes as prompt
 * templates and `uptimizr agent report --skill` runs headlessly, so what is
 * asserted here is the contract both consumers depend on: stable names, the
 * tools each method relies on, scene scoping that reaches the text, and a
 * resolver that fails loudly on a typo.
 */

import { describe, expect, it } from "vitest";
import { AGENT_SKILLS, AGENT_SKILL_NAMES, getAgentSkill, renderAgentSkill } from "../skills.js";
import { readTools } from "../tools.js";

describe("AGENT_SKILLS", () => {
  it("ships the three curated investigations under stable names", () => {
    expect([...AGENT_SKILL_NAMES].sort()).toEqual([
      "attention_hotspots",
      "weekly_scene_health",
      "xr_comfort_review",
    ]);
  });

  it("names only tools that exist in the generated catalog", () => {
    const catalog = new Set(readTools.map((tool) => tool.name));
    for (const skill of AGENT_SKILLS) {
      expect(skill.tools.length).toBeGreaterThan(0);
      for (const tool of skill.tools) {
        expect(catalog, `${skill.name} names ${tool}`).toContain(tool);
      }
    }
  });

  it("mentions each of its tools in the rendered text", () => {
    for (const skill of AGENT_SKILLS) {
      const text = skill.render({ scene: "lobby" });
      for (const tool of skill.tools) expect(text).toContain(`\`${tool}\``);
    }
  });

  it("opens every skill by telling the agent to orient on the project first", () => {
    for (const skill of AGENT_SKILLS) {
      expect(skill.render({ scene: "lobby" })).toContain("uptimizr://context");
    }
  });
});

describe("rendering", () => {
  it("scopes a project-wide skill to a scene when one is given", () => {
    const skill = getAgentSkill("weekly_scene_health")!;
    expect(skill.render({ scene: "lobby" })).toContain('scene "lobby"');
    expect(skill.render({})).toContain("all scenes");
  });

  it("renders the scene-scoped skill around the scene it was given", () => {
    expect(renderAgentSkill("attention_hotspots", { scene: "gallery" })).toContain(
      'scene="gallery"',
    );
  });

  it("rejects an unknown skill, naming the ones that exist", () => {
    expect(getAgentSkill("nope")).toBeUndefined();
    expect(() => renderAgentSkill("nope")).toThrow(/weekly_scene_health/);
  });

  it("rejects a missing required argument rather than rendering an empty scope", () => {
    expect(() => renderAgentSkill("attention_hotspots")).toThrow(/requires the "scene" argument/);
  });
});
