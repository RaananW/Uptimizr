/**
 * The SKILL.md files are the source of truth (ADR 0051 §7, design sketch §G.4);
 * `skills.generated.ts` is their compiled form. This suite guards both ends of
 * that seam:
 *
 * - every file parses, stays inside the line budget, and names only tools that
 *   really exist — a methodology that tells an agent to call `fps_trend` sends
 *   it into a tool-not-found loop, and nothing else in the build would catch it;
 * - the committed generated module still matches the files, so a hand-edit of
 *   the generated file (or a SKILL.md edited without running `pnpm gen:skills`)
 *   fails here as well as in CI's `gen:skills:check`.
 *
 * This is the one place in the package that touches `node:fs`, and it is a test:
 * the shipped modules stay browser-safe.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allMetrics } from "@uptimizr/metrics";
import { NON_REGISTRY_READ_TOOLS } from "../nonRegistryTools.js";
import { QUERY_TOOL_NAME } from "../queryTool.js";
import { writeTools } from "../writeTools.js";
import { GENERATED_AGENT_SKILLS } from "../skills.generated.js";

/** The generator, loaded as the plain ESM script it is. */
interface SkillGenerator {
  MAX_SKILL_LINES: number;
  parseSkillFile(text: string, id: string, source?: string): { name: string; tools: string[] };
  loadSkills(dir?: string): Promise<unknown[]>;
  renderFormattedModule(skills: unknown[]): Promise<string>;
}

const REPO_ROOT = new URL("../../../../../", import.meta.url);
const SKILLS_DIR = fileURLToPath(new URL("oss/packages/agent-core/skills/", REPO_ROOT));
const GENERATED = fileURLToPath(
  new URL("oss/packages/agent-core/src/skills.generated.ts", REPO_ROOT),
);

// A computed specifier, so TypeScript does not try to resolve types for a .mjs
// build script that has none. The generator is the same module `pnpm gen:skills`
// runs — re-implementing the parse here would defeat the point of the check.
const generatorUrl = new URL("scripts/gen-agent-skills.mjs", REPO_ROOT).href;
const generator = (await import(/* @vite-ignore */ generatorUrl)) as SkillGenerator;

/**
 * Every tool name a skill's method is allowed to name: the registry metrics the
 * collector actually **serves** (a registry entry with no endpoint, like
 * `perf_daily`, is reachable through the `query` DSL but is not a tool), the DSL
 * tool itself, the non-metric reads, and the metadata write tools.
 */
const KNOWN_TOOLS = new Set<string>([
  ...allMetrics()
    .filter((metric) => metric.endpoint)
    .map((metric) => metric.id as string),
  QUERY_TOOL_NAME,
  ...NON_REGISTRY_READ_TOOLS.map((tool) => tool.name),
  ...writeTools.map((tool) => tool.name),
]);

const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("skills/*/SKILL.md", () => {
  it("ships one directory per packaged skill", () => {
    expect(skillDirs).toEqual([
      "attention-hotspots",
      "conversion-investigation",
      "performance-regression-triage",
      "weekly-scene-health",
      "xr-comfort-audit",
    ]);
  });

  it.each(skillDirs)("%s parses and stays within the line budget", (id) => {
    const text = readFileSync(`${SKILLS_DIR}${id}/SKILL.md`, "utf8");
    expect(text.split(/\r?\n/).length).toBeLessThanOrEqual(generator.MAX_SKILL_LINES);
    expect(() => generator.parseSkillFile(text, id)).not.toThrow();
  });

  it.each(skillDirs)("%s names only tools the collector actually serves", (id) => {
    const parsed = generator.parseSkillFile(
      readFileSync(`${SKILLS_DIR}${id}/SKILL.md`, "utf8"),
      id,
    );
    for (const tool of parsed.tools) {
      expect(KNOWN_TOOLS, `${id} names "${tool}", which is not a tool`).toContain(tool);
    }
  });

  it("compiles to exactly the committed skills.generated.ts", async () => {
    const skills = await generator.loadSkills(SKILLS_DIR);
    const rendered = await generator.renderFormattedModule(skills);
    expect(
      rendered,
      "skills.generated.ts is stale or was hand-edited — run `pnpm gen:skills`",
    ).toBe(readFileSync(GENERATED, "utf8"));
  });

  it("compiles every file into the generated catalog", () => {
    expect(GENERATED_AGENT_SKILLS.map((skill) => skill.id)).toEqual(skillDirs);
  });
});
