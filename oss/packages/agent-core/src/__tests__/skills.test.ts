/**
 * The packaged agent skills (ADR 0050 §7, ADR 0051 §6–§7).
 *
 * These are the same investigations `@uptimizr/mcp` exposes as prompt templates
 * and `uptimizr agent report --skill` runs headlessly, so what is asserted here
 * is the contract both consumers depend on: stable names, tools that exist,
 * scene scoping that reaches the text, and a resolver that fails loudly on a
 * typo but forgives a dialect.
 *
 * The SKILL.md files themselves — the source of truth this module is compiled
 * from — are checked in `skillFiles.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { AGENT_SKILLS, AGENT_SKILL_NAMES, getAgentSkill, renderAgentSkill } from "../skills.js";
import { readTools } from "../tools.js";
import { writeTools } from "../writeTools.js";

/** Every tool name a skill is allowed to name: the read catalog plus the writes. */
const KNOWN_TOOLS = new Set([
  ...readTools.map((tool) => tool.name),
  ...writeTools.map((tool) => tool.name),
]);

describe("AGENT_SKILLS", () => {
  it("ships the five packaged methodologies under stable names", () => {
    expect([...AGENT_SKILL_NAMES].sort()).toEqual([
      "attention_hotspots",
      "conversion_investigation",
      "performance_regression_triage",
      "weekly_scene_health",
      "xr_comfort_audit",
    ]);
  });

  it("names only tools that exist in the generated catalog", () => {
    for (const skill of AGENT_SKILLS) {
      expect(skill.tools.length).toBeGreaterThan(0);
      for (const tool of skill.tools) {
        expect(KNOWN_TOOLS, `${skill.name} names ${tool}`).toContain(tool);
      }
    }
  });

  it("mentions each of its tools in the rendered text", () => {
    for (const skill of AGENT_SKILLS) {
      const text = skill.render({ scene: "lobby" });
      for (const tool of skill.tools) expect(text, skill.name).toContain(`\`${tool}\``);
    }
  });

  it("opens every skill by telling the agent to orient on the project first", () => {
    for (const skill of AGENT_SKILLS) {
      expect(skill.render({ scene: "lobby" })).toContain("uptimizr://context");
    }
  });

  it("declares the capabilities a key needs to follow the method", () => {
    for (const skill of AGENT_SKILLS) {
      expect(skill.capabilities, skill.name).toContain("query");
    }
  });

  it("describes when to use it, so a client can pick one without reading the body", () => {
    for (const skill of AGENT_SKILLS) {
      expect(skill.description, skill.name).toContain("USE FOR:");
      expect(skill.description, skill.name).toContain("Trigger phrases:");
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

  it("substitutes the range argument, falling back to the skill's own default", () => {
    const skill = getAgentSkill("weekly_scene_health")!;
    expect(skill.render({})).toContain("the last 7 days");
    expect(skill.render({ range: "June" })).toContain("June");
    expect(skill.render({ range: "June" })).not.toContain("the last 7 days");
  });

  it("leaves no unsubstituted placeholder behind, with or without a scene", () => {
    for (const skill of AGENT_SKILLS) {
      expect(skill.render({ scene: "lobby" }), skill.name).not.toMatch(/\{\{/);
      expect(skill.render({}), skill.name).not.toMatch(/\{\{/);
    }
  });

  it("never leaves the trailing whitespace a dropped section would", () => {
    for (const skill of AGENT_SKILLS) {
      expect(skill.render({}), skill.name).not.toMatch(/[ \t]+\n/);
    }
  });

  it("rejects an unknown skill, naming the ones that exist", () => {
    expect(getAgentSkill("nope")).toBeUndefined();
    expect(() => renderAgentSkill("nope")).toThrow(/weekly_scene_health/);
  });

  it("rejects a missing required argument rather than rendering an empty scope", () => {
    expect(() => renderAgentSkill("attention_hotspots")).toThrow(/requires the "scene" argument/);
  });
});

describe("resolving a skill by name", () => {
  it("accepts the kebab-case directory name as well as the snake_case id", () => {
    expect(getAgentSkill("conversion-investigation")?.name).toBe("conversion_investigation");
    expect(getAgentSkill("  Weekly-Scene-Health  ")?.name).toBe("weekly_scene_health");
  });

  it("keeps the pre-#316 xr_comfort_review name working", () => {
    expect(getAgentSkill("xr_comfort_review")?.name).toBe("xr_comfort_audit");
    expect(renderAgentSkill("xr_comfort_review")).toContain("`xr_rotation`");
  });
});
