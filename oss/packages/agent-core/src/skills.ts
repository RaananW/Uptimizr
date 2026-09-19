/**
 * **Packaged agent skills** — the canned investigations a client can run against
 * a project's analytics (ADR 0050 §7, ADR 0051 §6–§7, design sketch §G.4).
 *
 * A skill is a named methodology: a short title, the tools its method relies on,
 * the capabilities an API key needs to follow it, the arguments it accepts, and
 * a `render` that turns those arguments into the single user turn that steers an
 * agent. No data is fetched here and no model is called — a skill is text plus
 * metadata, so the same definition serves every consumer:
 *
 * - `@uptimizr/mcp` registers each one as an MCP **prompt template**
 *   (`prompts/list` → `prompts/get`) and lists them on `uptimizr://skills`.
 * - `uptimizr agent report --skill <name>` in the collector CLI seeds its
 *   headless `runAgent` transcript with the rendered text (ADR 0051 §6, design
 *   sketch §F.4).
 * - `@uptimizr/agent-eval` asks the bank the very questions a real client sends.
 * - The in-browser assistant offers them as starter prompts.
 *
 * ### Where the text lives
 *
 * Not here. Each skill is an **Agent Skills file** —
 * `oss/packages/agent-core/skills/<name>/SKILL.md` — with YAML frontmatter
 * (`name`, `title`, `description`, `tools`, `capabilities`, `args`) and a
 * Markdown body holding the methodology. Those files are the source of truth:
 * they ship in the `@uptimizr/agent-core` and `@uptimizr/mcp` tarballs, and a
 * user can lift one straight into their own agent.
 *
 * They cannot be read at runtime, because this package is browser-safe and must
 * not touch `node:fs`. So `scripts/gen-agent-skills.mjs` compiles them into
 * {@link GENERATED_AGENT_SKILLS} (`skills.generated.ts`) and this module turns
 * that data into {@link AgentSkill} values. Reword a SKILL.md, run
 * `pnpm gen:skills`, and every consumer's wording changes with it, with nothing
 * to keep in step. `pnpm gen:skills:check` is the CI gate that fails on a
 * hand-edited generated file.
 *
 * ### Body placeholders
 *
 * A body is a template with a deliberately tiny vocabulary — enough to scope a
 * methodology, not a second templating language:
 *
 * - `{{scene}}` — the scene id, or the empty string.
 * - `{{scope}}` — `scene "lobby"`, or `the project (all scenes)`.
 * - `{{range}}` — the window, in words, defaulting to the argument's `default`.
 * - `{{#name}}…{{/name}}` / `{{^name}}…{{/name}}` — a section kept only when the
 *   argument is, or is not, present. Sections may span lines.
 */

import {
  GENERATED_AGENT_SKILLS,
  type GeneratedAgentSkill,
  type GeneratedAgentSkillArg,
} from "./skills.generated.js";

/** One argument a skill's {@link AgentSkill.render} accepts. */
export type AgentSkillArg = GeneratedAgentSkillArg;

/** A named, renderable investigation methodology. */
export interface AgentSkill {
  /** The skill directory name under `skills/` (kebab-case). */
  id: string;
  /** Stable identifier (`weekly_scene_health`) — what `--skill` and MCP take. */
  name: string;
  /** Human title for a picker. */
  title: string;
  /**
   * What the skill produces, its `USE FOR:` cases and its trigger phrases, as
   * one paragraph — the text an MCP client shows in `prompts/list`.
   */
  description: string;
  /**
   * The tool names the skill's method relies on, in the order its text mentions
   * them. Advisory: the agent may call others, or fewer. Consumers use it to
   * preview a run (`--dry-run`), to describe a skill, and to drive a
   * deterministic scripted provider that needs no model.
   */
  tools: readonly string[];
  /**
   * The API-key capabilities the method needs (ADR 0051 §7). Every skill needs
   * `query`; one that reads raw per-session detail would also need `query:raw`.
   * A host can use this to hide a skill the configured key could not complete.
   */
  capabilities: readonly string[];
  /** The arguments `render` understands. */
  args: readonly AgentSkillArg[];
  /** Render the single user turn that asks for this investigation. */
  render(args?: Record<string, string | undefined>): string;
}

/** `{{#name}}…{{/name}}` and `{{^name}}…{{/name}}`, possibly spanning lines. */
const SECTION = /\{\{([#^])([a-z][a-z0-9_]*)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
/** `{{name}}`. */
const VARIABLE = /\{\{([a-z][a-z0-9_]*)\}\}/g;

/** `scene "lobby"` when a scene was given, otherwise the whole project. */
function scopeFor(scene: string | undefined): string {
  return scene ? `scene "${scene}"` : "the project (all scenes)";
}

/**
 * Substitute a skill's arguments into its body.
 *
 * Sections are resolved before variables so a `{{scene}}` inside a dropped
 * `{{#scene}}` block never renders, and the trailing whitespace a dropped
 * section can leave behind is stripped per line — otherwise a scene-less render
 * would carry invisible spaces the authored file never had.
 */
function renderBody(body: string, values: Record<string, string>): string {
  const resolved = body
    .replace(SECTION, (_match, kind: string, name: string, inner: string) =>
      (kind === "#") === Boolean(values[name]) ? inner : "",
    )
    .replace(VARIABLE, (_match, name: string) => values[name] ?? "");
  return resolved.replace(/[ \t]+$/gm, "");
}

/** Turn one compiled SKILL.md into the renderable skill consumers use. */
function toAgentSkill(source: GeneratedAgentSkill): AgentSkill {
  return {
    id: source.id,
    name: source.name,
    title: source.title,
    description: source.description,
    tools: source.tools,
    capabilities: source.capabilities,
    args: source.args,
    render(args: Record<string, string | undefined> = {}): string {
      const values: Record<string, string> = {};
      for (const arg of source.args) {
        values[arg.name] = args[arg.name]?.trim() || arg.default || "";
      }
      // `scope` is derived rather than declared: a skill that takes a scene
      // always wants to open with "scene X" or "the whole project", and spelling
      // that out in five frontmatter blocks would invite five phrasings of it.
      values.scope = scopeFor(values.scene);
      return renderBody(source.body, values);
    },
  };
}

/**
 * The packaged skills, in catalog order. The text of each is the contract: it is
 * what an MCP client shows its user and what the report CLI sends as the user
 * turn, so changing a SKILL.md changes every consumer at once (which is the
 * point).
 */
export const AGENT_SKILLS: readonly AgentSkill[] = GENERATED_AGENT_SKILLS.map(toAgentSkill);

/** The packaged skill names, in catalog order. */
export const AGENT_SKILL_NAMES: readonly string[] = AGENT_SKILLS.map((skill) => skill.name);

/**
 * Names that used to identify a skill and still resolve to one.
 *
 * `xr_comfort_review` shipped as an MCP prompt and a `--skill` value before the
 * methodology was packaged and widened into `xr_comfort_audit` (#316). An MCP
 * client's saved prompt reference and an operator's cron line both name a skill
 * by string, so the old name keeps working rather than failing on the next
 * scheduled run.
 */
const SKILL_ALIASES: Readonly<Record<string, string>> = {
  xr_comfort_review: "xr_comfort_audit",
};

/**
 * Resolve a skill by name, or `undefined` when nothing answers to it.
 *
 * The one lookup every consumer goes through, and deliberately forgiving about
 * spelling: a skill's directory is kebab-case (`xr-comfort-audit`) and its id is
 * snake_case (`xr_comfort_audit`), so both resolve, as do the historical names
 * in {@link SKILL_ALIASES}.
 */
export function getAgentSkill(name: string): AgentSkill | undefined {
  const normalized = name.trim().toLowerCase().replace(/-/g, "_");
  const resolved = SKILL_ALIASES[normalized] ?? normalized;
  return AGENT_SKILLS.find((skill) => skill.name === resolved);
}

/**
 * Render one skill's user turn, throwing on an unknown name (a typo should fail
 * loudly rather than silently produce an empty prompt) or on a missing required
 * argument.
 */
export function renderAgentSkill(
  name: string,
  args: Record<string, string | undefined> = {},
): string {
  const skill = getAgentSkill(name);
  if (!skill) {
    throw new Error(`Unknown skill "${name}". Known skills: ${AGENT_SKILL_NAMES.join(", ")}.`);
  }
  for (const arg of skill.args) {
    if (arg.required && !args[arg.name]) {
      throw new Error(`Skill "${name}" requires the "${arg.name}" argument.`);
    }
  }
  return skill.render(args);
}
