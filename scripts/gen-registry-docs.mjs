#!/usr/bin/env node
//
// Render every hand-maintained metric table from the semantic metric registry
// (ADR 0051 §1, design sketch §A.2). The registry in `@uptimizr/metrics` is
// the single source of truth for what the collector can compute; this script
// projects it into the places that used to restate it by hand:
//
//   docs/integration.md                              §Query (read) endpoint table
//   oss/apps/docs/src/content/docs/api/query.mdx     the docs-site query reference
//   oss/apps/docs/.../guides/mcp.md                  the docs-site MCP tool catalog
//   oss/packages/mcp/README.md                       the tool table
//   oss/packages/mcp/AGENTS.md, llms.txt             the packaged tool catalog (ADR 0017)
//   oss/packages/agent-core/README.md, AGENTS.md, llms.txt
//
// Only the text between a pair of markers is replaced, so the hand-written prose
// around each table survives:
//
//   Markdown / text:  <!-- generated:<block>:start ... -->  …  <!-- generated:<block>:end -->
//   MDX:              {/* generated:<block>:start ... */}   …  {/* generated:<block>:end */}
//
// (MDX has no HTML comments — `<!-- -->` is parsed as JSX there — hence the two
// marker dialects.)
//
// Run locally:   pnpm gen:docs
// Staleness gate: pnpm gen:docs:check   (exits non-zero when committed output drifted)
//
// A second data source rides along: the **packaged methodology skills**
// (ADR 0051 §7), compiled from `oss/packages/agent-core/skills/*/SKILL.md` into
// `@uptimizr/agent-core` by `scripts/gen-agent-skills.mjs`. The skill tables in
// the guides, the report-CLI reference and the packaged docs render from them
// for the same reason the metric tables render from the registry: a hand-kept
// copy drifts the first time a methodology is reworded.
//
// Both are imported from **built** output, so run `pnpm build` (or
// `pnpm --filter @uptimizr/mcp... build`) first; CI runs this after its build
// step.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY_ENTRY = "oss/packages/metrics/dist/index.js";
const AGENT_CORE_ENTRY = "oss/packages/agent-core/dist/index.js";

/** Import one package's built entry point by absolute path. */
async function loadBuilt(relative, buildHint) {
  const entry = new URL(`file://${path.resolve(ROOT, relative).split(path.sep).join("/")}`);
  try {
    return await import(entry.href);
  } catch (error) {
    throw new Error(
      `Could not load ${relative}.\nBuild it first:  ${buildHint}\n\n` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The two data sources the blocks render from: the metric registry, and the
 * packaged agent skills. Merged into one object so each block renderer can
 * destructure exactly what it needs.
 */
async function loadSources() {
  const registry = await loadBuilt(REGISTRY_ENTRY, "pnpm --filter @uptimizr/metrics... build");
  const agentCore = await loadBuilt(
    AGENT_CORE_ENTRY,
    "pnpm --filter @uptimizr/agent-core... build",
  );
  return { ...registry, AGENT_SKILLS: agentCore.AGENT_SKILLS };
}

// --- rendering helpers ----------------------------------------------------

/**
 * Make a value safe to place in one Markdown table cell: collapse newlines, then
 * backslash-escape the cell delimiter. The backslash itself is escaped in the
 * same pass — escaping only `|` would turn a registry string ending in `\` into
 * `\\|`, which Markdown renders as a literal backslash followed by a *column
 * break*, silently shifting the rest of the row.
 */
function cell(value) {
  return String(value)
    .replace(/\s*\n\s*/g, " ")
    .replace(/[\\|]/g, (char) => `\\${char}`)
    .trim();
}

/** `` `a`, `b`, `c` `` — or an em dash when the list is empty. */
function codeList(values) {
  return values.length === 0 ? "—" : values.map((value) => `\`${value}\``).join(", ");
}

/** Render a Markdown table. Prettier aligns the columns afterwards. */
function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/**
 * A skill's description without its trigger phrases.
 *
 * A `SKILL.md` description carries three things: what the skill produces, a
 * `USE FOR:` list, and `Trigger phrases:` — the wording that should make an
 * agent reach for it. The first two are what a human reader wants; the third is
 * machine-facing noise in a docs table, and it is still shipped verbatim in the
 * skill file and in `prompts/list`.
 */
function skillSummary(skill) {
  return skill.description.split(/\s*Trigger phrases:/)[0].trim();
}

/** Wrap a comma-separated list of inline-code names at `width` columns. */
function wrapList(names, width = 98) {
  const lines = [];
  let line = "";
  names.forEach((name, index) => {
    const token = `\`${name}\`${index === names.length - 1 ? "" : ","}`;
    if (line.length === 0) line = token;
    else if (line.length + 1 + token.length <= width) line += ` ${token}`;
    else {
      lines.push(line);
      line = token;
    }
  });
  if (line.length > 0) lines.push(line);
  return lines.join("\n");
}

/** Human title for each registry category, used as a section heading. */
const CATEGORY_TITLES = {
  sessions: "Sessions & scenes",
  attention: "Attention & heatmaps",
  interaction: "Meshes & interactions",
  navigation: "Navigation & coverage",
  performance: "Performance & stability",
  errors: "Errors & diagnostics",
  xr: "WebXR",
  ar: "WebXR AR placement",
  conversion: "Funnels & conversion",
};

/** Every request parameter a metric accepts: path params first, then filters. */
function paramsOf(metric) {
  return [...(metric.endpoint?.pathParams ?? []), ...metric.filters];
}

// --- blocks ---------------------------------------------------------------
//
// One renderer per marker name. Each takes the registry module and returns the
// Markdown that replaces the text between its markers.

const BLOCKS = {
  /** `docs/integration.md` — the §Query (read) endpoint table. */
  "registry-endpoints": ({ allMetrics }) =>
    table(
      ["Method", "Path", "Metric", "Purpose"],
      allMetrics()
        .filter((metric) => metric.endpoint)
        .map((metric) => [
          `\`${metric.endpoint.method}\``,
          `\`${metric.endpoint.path}\``,
          `\`${metric.id}\``,
          cell(metric.description),
        ]),
    ),

  /** The docs-site query reference: one table per registry category. */
  "registry-query-reference": ({ allMetrics }) => {
    const metrics = allMetrics().filter((metric) => metric.endpoint);
    const categories = [...new Set(metrics.map((metric) => metric.category))];
    return categories
      .map((category) => {
        const rows = metrics
          .filter((metric) => metric.category === category)
          .map((metric) => [
            `\`${metric.endpoint.method}\``,
            `\`${metric.endpoint.path}\``,
            `\`${metric.id}\``,
            cell(metric.grain),
            codeList(paramsOf(metric)),
            cell(metric.description),
          ]);
        return `## ${CATEGORY_TITLES[category] ?? category}\n\n${table(
          ["Method", "Path", "Metric", "One row is", "Parameters", "Purpose"],
          rows,
        )}`;
      })
      .join("\n\n");
  },

  /**
   * The docs-site MCP guide's tool catalog: one `####` table per registry
   * category, narrower than the packaged README table (no parameter column —
   * the guide documents the shared parameters in prose above it).
   */
  "registry-guide-tools": ({ allMetrics }) => {
    const metrics = allMetrics().filter((metric) => metric.endpoint);
    const categories = [...new Set(metrics.map((metric) => metric.category))];
    return categories
      .map((category) => {
        const rows = metrics
          .filter((metric) => metric.category === category)
          .map((metric) => [
            `\`${metric.id}\``,
            `\`${metric.endpoint.path}\``,
            cell(metric.title),
          ]);
        return `#### ${CATEGORY_TITLES[category] ?? category}\n\n${table(
          ["Tool", "Endpoint", "Returns"],
          rows,
        )}`;
      })
      .join("\n\n");
  },

  /** The packaged tool table (`@uptimizr/mcp` README). */
  "registry-tools": ({ allMetrics }) =>
    table(
      ["Tool", "Endpoint", "Returns", "Parameters"],
      allMetrics()
        .filter((metric) => metric.endpoint)
        .map((metric) => [
          `\`${metric.id}\``,
          `\`${metric.endpoint.path}\``,
          cell(metric.title),
          codeList(paramsOf(metric)),
        ]),
    ),

  /**
   * The metrics the query DSL can **regroup** (ADR 0051 §3, #304): the ones
   * whose measure is a portable count or sum over promoted columns, with the
   * grain they answer at by default and the dimensions they accept instead.
   *
   * Generated, because the alternative is a hand-kept list that drifts the
   * first time a metric gains or loses `genericGroupBy`.
   */
  "registry-generic-groupby": ({ allMetrics, GENERIC_DIMENSIONS }) =>
    table(
      ["Metric", "Default grain", "Can also group by", "Measures"],
      allMetrics()
        .filter((metric) => metric.genericGroupBy)
        .map((metric) => [
          `\`${metric.id}\``,
          codeList(metric.grainDimensions),
          codeList(
            metric.dimensions.filter(
              (dimension) =>
                GENERIC_DIMENSIONS.includes(dimension) &&
                !metric.grainDimensions.includes(dimension),
            ),
          ),
          codeList(metric.genericGroupBy.measures.map((measure) => measure.column)),
        ]),
    ),
  /**
   * A compact name list for the packaged `AGENTS.md` / `llms.txt` (ADR 0017).
   *
   * Split by the capability each tool needs (ADR 0051 §7): the main list is what
   * every `query` key sees, and a capability-gated tool is named separately
   * because a host registers it only for a key that holds the capability.
   * Listing them together would promise a tool most keys do not have.
   */
  "registry-tool-names": ({ allMetrics, metricCapability }) => {
    const served = allMetrics().filter((metric) => metric.endpoint);
    const withCapability = (capability) =>
      served.filter((metric) => metricCapability(metric) === capability).map((metric) => metric.id);
    const base = wrapList(withCapability("query"));
    const raw = withCapability("query:raw");
    if (raw.length === 0) return base;
    return [
      base,
      "",
      "Only on a key holding `query:raw`, and only when the collector runs with",
      "`ENABLE_RAW_SESSION_RETENTION` (ADR 0003):",
      "",
      wrapList(raw),
    ].join("\n");
  },

  /**
   * The packaged **methodology skills** (ADR 0051 §7, #316): what each one
   * produces and when to reach for it, the arguments it takes, and the tools its
   * method names. Rendered from `AGENT_SKILLS`, which is itself compiled from
   * the `SKILL.md` files — so the only place a skill is described by hand is the
   * file that *is* the skill.
   *
   * The trigger phrases are dropped: they steer an agent's skill selection and
   * are noise in a human-facing table. The `USE FOR:` half is kept, because it
   * is the "when to use it" column a reader is looking for.
   */
  "registry-skills": ({ AGENT_SKILLS }) =>
    table(
      ["Skill", "Arguments", "What it produces, and when to use it", "Tools its method names"],
      AGENT_SKILLS.map((skill) => [
        `\`${skill.name}\``,
        codeList(skill.args.map((arg) => (arg.required ? `${arg.name}*` : `${arg.name}?`))),
        cell(skillSummary(skill)),
        codeList(skill.tools),
      ]),
    ),

  /**
   * A compact skill list for the packaged `AGENTS.md` / `llms.txt` (ADR 0017):
   * one line per skill, naming the file that holds the method so an agent that
   * has the tarball can open it.
   */
  "registry-skill-names": ({ AGENT_SKILLS }) =>
    AGENT_SKILLS.map((skill) => {
      const args = skill.args
        .map((arg) => (arg.required ? `${arg.name} (required)` : `${arg.name}`))
        .join(", ");
      return [
        `- \`${skill.name}\`${args ? ` (${args})` : ""} — ${skillSummary(skill)}`,
        `  Method: \`skills/${skill.id}/SKILL.md\`. Tools: ${codeList(skill.tools)}.`,
      ].join("\n");
    }).join("\n"),
};

// --- targets --------------------------------------------------------------

/** Every file this script owns, and the blocks it renders into each. */
const TARGETS = [
  { file: "docs/integration.md", blocks: ["registry-endpoints", "registry-generic-groupby"] },
  {
    file: "oss/apps/docs/src/content/docs/api/query.mdx",
    blocks: ["registry-query-reference", "registry-generic-groupby"],
  },
  {
    file: "oss/apps/docs/src/content/docs/guides/mcp.md",
    blocks: ["registry-guide-tools", "registry-skills"],
  },
  { file: "oss/apps/docs/src/content/docs/guides/agents.mdx", blocks: ["registry-skills"] },
  { file: "oss/apps/docs/src/content/docs/deploy/collector.mdx", blocks: ["registry-skills"] },
  { file: "oss/packages/mcp/README.md", blocks: ["registry-tools", "registry-skills"] },
  { file: "oss/packages/mcp/AGENTS.md", blocks: ["registry-tool-names", "registry-skill-names"] },
  { file: "oss/packages/mcp/llms.txt", blocks: ["registry-tool-names", "registry-skill-names"] },
  {
    file: "oss/packages/agent-core/README.md",
    blocks: ["registry-tool-names", "registry-skills"],
  },
  {
    file: "oss/packages/agent-core/AGENTS.md",
    blocks: ["registry-tool-names", "registry-skill-names"],
  },
  {
    file: "oss/packages/agent-core/llms.txt",
    blocks: ["registry-tool-names", "registry-skill-names"],
  },
];

/** The two marker dialects: MDX cannot carry HTML comments. */
function markers(file, block) {
  const mdx = file.endsWith(".mdx");
  return mdx
    ? {
        start: new RegExp(`\\{/\\*\\s*generated:${block}:start[^*]*\\*/\\}`),
        end: new RegExp(`\\{/\\*\\s*generated:${block}:end\\s*\\*/\\}`),
      }
    : {
        start: new RegExp(`<!--\\s*generated:${block}:start[^>]*-->`),
        end: new RegExp(`<!--\\s*generated:${block}:end\\s*-->`),
      };
}

/** Replace the text between one block's markers. */
function replaceBlock(file, contents, block, rendered) {
  const { start, end } = markers(file, block);
  const startMatch = start.exec(contents);
  const endMatch = end.exec(contents);
  if (!startMatch || !endMatch) {
    throw new Error(
      `${file}: missing the \`generated:${block}\` ${startMatch ? "end" : "start"} marker. ` +
        `Add the marker pair around the generated section.`,
    );
  }
  const from = startMatch.index + startMatch[0].length;
  const to = endMatch.index;
  if (to < from) throw new Error(`${file}: \`generated:${block}\` markers are out of order.`);
  return `${contents.slice(0, from)}\n\n${rendered}\n\n${contents.slice(to)}`;
}

/**
 * Extensions the repo's own `format` script covers
 * (`prettier --write "**\/*.{ts,tsx,js,jsx,json,md,yml,yaml}"`). Generated output
 * for these files is run through Prettier so it is byte-identical to what
 * `pnpm format:check` expects (Prettier aligns Markdown table columns). Files
 * Prettier does not own — `.mdx`, `.txt` — are written as rendered.
 */
const FORMATTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".yml",
  ".yaml",
]);

/** Format with the repo's Prettier config, when Prettier owns the file type. */
async function format(prettier, absolute, contents) {
  if (!FORMATTED_EXTENSIONS.has(path.extname(absolute))) return contents;
  const options = await prettier.resolveConfig(absolute, { editorconfig: false });
  return prettier.format(contents, { ...options, filepath: absolute });
}

async function main() {
  const check = process.argv.includes("--check");
  // `--root <dir>` renders into a copy of the target files under another
  // directory instead of the working tree. The registry is always read from this
  // repo; only the destinations move. Used by the generator's own tests to prove
  // that `--check` detects a stale table without touching committed files.
  const rootFlag = process.argv.indexOf("--root");
  const targetRoot = rootFlag === -1 ? ROOT : path.resolve(process.argv[rootFlag + 1] ?? ".");
  const sources = await loadSources();
  const prettier = await import("prettier");

  const rendered = Object.fromEntries(
    Object.entries(BLOCKS).map(([name, render]) => [name, render(sources)]),
  );

  const stale = [];
  for (const target of TARGETS) {
    const absolute = path.resolve(targetRoot, target.file);
    const original = await readFile(absolute, "utf8");
    let next = original;
    for (const block of target.blocks) {
      next = replaceBlock(target.file, next, block, rendered[block]);
    }
    // Always resolve Prettier options against the real file in this repo, so
    // `--root` output is formatted identically to the working tree's.
    next = await format(prettier, path.resolve(ROOT, target.file), next);
    if (next === original) continue;
    if (check) stale.push(target.file);
    else {
      await writeFile(absolute, next, "utf8");
      console.log(`updated  ${target.file}`);
    }
  }

  if (check && stale.length > 0) {
    console.error(
      `\nThese files are generated from the metric registry and are out of date:\n` +
        stale.map((file) => `  - ${file}`).join("\n") +
        `\n\nRun \`pnpm gen:docs\` and commit the result.\n`,
    );
    process.exit(1);
  }
  console.log(
    check
      ? `ok  ${TARGETS.length} generated files are up to date`
      : `done  ${TARGETS.length} files checked`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
