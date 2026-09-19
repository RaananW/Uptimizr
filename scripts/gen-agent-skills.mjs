#!/usr/bin/env node
//
// Compile the packaged methodology skills into `@uptimizr/agent-core` source
// (ADR 0051 §7, design sketch §G.4).
//
// `oss/packages/agent-core/skills/<dir>/SKILL.md` is the **source of truth** for
// every curated investigation the project ships: an Agent Skills file with YAML
// frontmatter (`name`, `title`, `description`, `tools`, `capabilities`, `args`)
// and a Markdown body holding the methodology. Those files are what a human
// reads, what ships in the `@uptimizr/agent-core` and `@uptimizr/mcp` tarballs,
// and what a user can lift into their own agent.
//
// They cannot, however, be read at runtime: `@uptimizr/agent-core` is
// browser-safe and must not touch `node:fs`. So this script projects them into
//
//   oss/packages/agent-core/src/skills.generated.ts
//
// as plain data, and `src/skills.ts` turns that data into the `AgentSkill`
// values every consumer already uses (the MCP prompt templates, `uptimizr agent
// report --skill`, the eval bank). Edit the SKILL.md, never the generated file.
//
// Run locally:    pnpm gen:skills
// Staleness gate: pnpm gen:skills:check   (exits non-zero when the committed
//                 output drifted from the SKILL.md files — including when the
//                 generated file itself was hand-edited)
//
// Unlike `gen-registry-docs.mjs` this needs no build: it reads the Markdown
// sources directly, so it can run before anything is compiled.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Where the SKILL.md files live, relative to the repo root. */
export const SKILLS_DIR = "oss/packages/agent-core/skills";
/** The module this script owns, relative to the repo root. */
export const GENERATED_FILE = "oss/packages/agent-core/src/skills.generated.ts";

/** Longest a skill file may be — a methodology, not a manual (design sketch §G.4). */
export const MAX_SKILL_LINES = 120;

// --- parsing --------------------------------------------------------------

/** Split `---\n<yaml>\n---\n<body>` into its two halves. */
function splitFrontmatter(text, source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) {
    throw new Error(`${source}: missing the \`---\` YAML frontmatter block at the top of the file.`);
  }
  return { frontmatter: match[1], body: match[2] };
}

function requireString(value, field, source) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source}: \`${field}\` must be a non-empty string.`);
  }
  return value.trim();
}

function requireStringArray(value, field, source) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${source}: \`${field}\` must be a non-empty list.`);
  }
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`, source));
}

/**
 * Parse one SKILL.md into the record the generated module carries.
 *
 * Exported so the package's own test can re-parse the files and assert the
 * committed output still matches — the same check `--check` performs, run on
 * every `pnpm test`.
 */
export function parseSkillFile(text, id, source = `${SKILLS_DIR}/${id}/SKILL.md`) {
  const lineCount = text.split(/\r?\n/).length;
  if (lineCount > MAX_SKILL_LINES) {
    throw new Error(
      `${source}: ${lineCount} lines, over the ${MAX_SKILL_LINES}-line budget. A skill is a ` +
        `method, not a manual — cut it or split it.`,
    );
  }

  const { frontmatter, body } = splitFrontmatter(text, source);
  const meta = parseYaml(frontmatter);
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error(`${source}: the frontmatter must be a YAML mapping.`);
  }

  const known = ["name", "title", "description", "tools", "capabilities", "args"];
  for (const key of Object.keys(meta)) {
    if (!known.includes(key)) {
      throw new Error(`${source}: unknown frontmatter key \`${key}\` (known: ${known.join(", ")}).`);
    }
  }

  const name = requireString(meta.name, "name", source);
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`${source}: \`name\` must be lower_snake_case, got "${name}".`);
  }
  if (name !== id.replace(/-/g, "_")) {
    throw new Error(
      `${source}: \`name\` is "${name}" but the directory is "${id}" — they must be the same ` +
        `identifier (the directory kebab-cased, the name snake_cased).`,
    );
  }

  const args = (meta.args ?? []).map((arg, index) => {
    const where = `args[${index}]`;
    if (arg === null || typeof arg !== "object" || Array.isArray(arg)) {
      throw new Error(`${source}: \`${where}\` must be a mapping.`);
    }
    const entry = {
      name: requireString(arg.name, `${where}.name`, source),
      description: requireString(arg.description, `${where}.description`, source),
      required: arg.required === true,
    };
    if (arg.default !== undefined) {
      entry.default = requireString(arg.default, `${where}.default`, source);
    }
    return entry;
  });

  // The blank line after the closing `---` is frontmatter punctuation, not part
  // of the method: a rendered skill must open with its own first sentence.
  const trimmedBody = body.replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (trimmedBody === "") throw new Error(`${source}: the body is empty.`);

  return {
    id,
    name,
    title: requireString(meta.title, "title", source),
    description: requireString(meta.description, "description", source).replace(/\s*\n\s*/g, " "),
    tools: requireStringArray(meta.tools, "tools", source),
    capabilities: requireStringArray(meta.capabilities, "capabilities", source),
    args,
    body: trimmedBody,
  };
}

/**
 * Read every `<dir>/SKILL.md` under `dir`, in directory-name order — which is
 * the catalog order every consumer shows.
 */
export async function loadSkills(dir = path.resolve(ROOT, SKILLS_DIR)) {
  const directories = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (directories.length === 0) throw new Error(`no skill directories found in ${dir}`);

  const skills = [];
  for (const id of directories) {
    const text = await readFile(path.join(dir, id, "SKILL.md"), "utf8");
    skills.push(parseSkillFile(text, id));
  }

  const seen = new Set();
  for (const skill of skills) {
    if (seen.has(skill.name)) throw new Error(`duplicate skill name "${skill.name}"`);
    seen.add(skill.name);
  }
  return skills;
}

// --- rendering ------------------------------------------------------------

const q = (value) => JSON.stringify(value);

/**
 * A body rendered as a joined array of lines rather than one escaped blob, so a
 * review of a reworded methodology reads as a line-by-line prose diff.
 */
function renderBody(body) {
  const lines = body.split("\n").map((line) => `      ${q(line)},`);
  return ["[", ...lines, '    ].join("\\n")'].join("\n");
}

function renderArg(arg) {
  const fields = [
    `        name: ${q(arg.name)},`,
    `        description: ${q(arg.description)},`,
    `        required: ${arg.required},`,
  ];
  if (arg.default !== undefined) fields.push(`        default: ${q(arg.default)},`);
  return ["      {", ...fields, "      },"].join("\n");
}

function renderSkill(skill) {
  return [
    "  {",
    `    id: ${q(skill.id)},`,
    `    name: ${q(skill.name)},`,
    `    title: ${q(skill.title)},`,
    `    description: ${q(skill.description)},`,
    `    tools: [${skill.tools.map(q).join(", ")}],`,
    `    capabilities: [${skill.capabilities.map(q).join(", ")}],`,
    skill.args.length === 0
      ? "    args: [],"
      : `    args: [\n${skill.args.map(renderArg).join("\n")}\n    ],`,
    `    body: ${renderBody(skill.body)},`,
    "  },",
  ].join("\n");
}

/** Render the whole generated module. */
export function renderModule(skills) {
  return `/**
 * GENERATED FILE — do not edit.
 *
 * Compiled from \`${SKILLS_DIR}/<name>/SKILL.md\` by
 * \`scripts/gen-agent-skills.mjs\`. Edit the SKILL.md file and run
 * \`pnpm gen:skills\`; \`pnpm gen:skills:check\` is the CI gate.
 *
 * This module is data only. \`skills.ts\` turns it into the renderable
 * {@link ./skills.js#AGENT_SKILLS} every consumer uses, which is why nothing
 * here touches \`node:fs\` — \`@uptimizr/agent-core\` stays browser-safe.
 */

/** One argument a skill's body can be rendered with. */
export interface GeneratedAgentSkillArg {
  /** Argument name, as written in the SKILL.md frontmatter. */
  name: string;
  /** One-line description, surfaced by MCP's \`prompts/list\` and by \`--list-skills\`. */
  description: string;
  /** Whether the skill is meaningless without it. */
  required: boolean;
  /** Value substituted when the caller passes none. */
  default?: string;
}

/** One SKILL.md, parsed. */
export interface GeneratedAgentSkill {
  /** The skill directory name (kebab-case). */
  id: string;
  /** The stable identifier (snake_case) MCP and \`--skill\` take. */
  name: string;
  /** Human title for a picker. */
  title: string;
  /** What the skill produces, including its USE FOR line and trigger phrases. */
  description: string;
  /** The tool names the method relies on, in the order the body mentions them. */
  tools: readonly string[];
  /** The API-key capabilities the method needs (ADR 0051 §7). */
  capabilities: readonly string[];
  /** The arguments the body understands. */
  args: readonly GeneratedAgentSkillArg[];
  /** The methodology, as a template — \`skills.ts\` documents the placeholders. */
  body: string;
}

/** Every packaged skill, in catalog (directory-name) order. */
export const GENERATED_AGENT_SKILLS: readonly GeneratedAgentSkill[] = [
${skills.map(renderSkill).join("\n")}
];
`;
}

/** Render the module exactly as it is committed, Prettier included. */
export async function renderFormattedModule(skills) {
  const prettier = await import("prettier");
  const absolute = path.resolve(ROOT, GENERATED_FILE);
  const options = await prettier.resolveConfig(absolute, { editorconfig: false });
  return prettier.format(renderModule(skills), { ...options, filepath: absolute });
}

// --- main -----------------------------------------------------------------

async function main() {
  const check = process.argv.includes("--check");
  const skills = await loadSkills();
  const formatted = await renderFormattedModule(skills);
  const absolute = path.resolve(ROOT, GENERATED_FILE);
  const current = await readFile(absolute, "utf8").catch(() => null);

  if (current === formatted) {
    console.log(`ok  ${GENERATED_FILE} is up to date (${skills.length} skills)`);
    return;
  }
  if (check) {
    console.error(
      `\n${GENERATED_FILE} is generated from ${SKILLS_DIR}/*/SKILL.md and is out of date.\n\n` +
        `Run \`pnpm gen:skills\` and commit the result.\n`,
    );
    process.exit(1);
  }
  await writeFile(absolute, formatted, "utf8");
  console.log(`updated  ${GENERATED_FILE} (${skills.length} skills)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
