/**
 * The registry docs generator (`scripts/gen-registry-docs.mjs`, issue #297).
 *
 * The endpoint/tool tables in `docs/integration.md`, the docs site and the
 * packaged `README`/`AGENTS.md`/`llms.txt` are rendered from the metric registry,
 * and the skill tables beside them from the packaged methodology skills
 * (ADR 0051 §7), so this suite proves the staleness gate actually works:
 *
 * - the **committed** output matches the registry (`--check` exits 0) — the same
 *   assertion CI makes, so a registry change that forgets `pnpm gen:docs` fails
 *   here too;
 * - a **mutated** table is detected (`--check` exits non-zero and names the
 *   file), run against a throwaway copy of the target files via `--root` so no
 *   committed file is ever touched.
 *
 * It lives in `@uptimizr/collector-server` because Turbo builds `@uptimizr/db`
 * before this package's tests (`test` dependsOn `^build`), and the generator
 * imports the registry from that built output.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/** Repo root, four levels up from `oss/apps/collector-server/src/__tests__`. */
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const GENERATOR = path.join(REPO_ROOT, "scripts", "gen-registry-docs.mjs");

/** The files the generator owns — mirrored by `TARGETS` in the script. */
const GENERATED_FILES = [
  "docs/integration.md",
  "oss/apps/docs/src/content/docs/api/query.mdx",
  "oss/apps/docs/src/content/docs/guides/mcp.md",
  "oss/apps/docs/src/content/docs/guides/agents.mdx",
  "oss/apps/docs/src/content/docs/deploy/collector.mdx",
  "oss/packages/mcp/README.md",
  "oss/packages/mcp/AGENTS.md",
  "oss/packages/mcp/llms.txt",
  "oss/packages/agent-core/README.md",
  "oss/packages/agent-core/AGENTS.md",
  "oss/packages/agent-core/llms.txt",
];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGenerator(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [GENERATOR, ...args], {
      cwd: REPO_ROOT,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

let scratch: string | undefined;
/** Throwaway target copies made by the marker suite below. */
const corrupted: string[] = [];

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  for (const dir of corrupted) await rm(dir, { recursive: true, force: true });
});

describe("gen-registry-docs", () => {
  it("reports the committed tables as up to date", async () => {
    const result = await runGenerator(["--check"]);
    expect(
      result.code,
      `\`pnpm gen:docs:check\` failed — run \`pnpm gen:docs\` and commit the result.\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain("up to date");
  }, 60_000);

  it("detects a stale table and names the file", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "uptimizr-gen-docs-"));
    for (const file of GENERATED_FILES) {
      const destination = path.join(scratch, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(REPO_ROOT, file), destination);
    }

    // The copy is faithful, so it starts clean.
    const clean = await runGenerator(["--check", "--root", scratch]);
    expect(clean.code, clean.stderr).toBe(0);

    // Drop a row from the generated tool table: exactly the drift CI must catch.
    const stalePath = path.join(scratch, "oss/packages/mcp/README.md");
    const contents = await readFile(stalePath, "utf8");
    const withoutTopMeshes = contents
      .split("\n")
      .filter((line) => !line.startsWith("| `top_meshes`"))
      .join("\n");
    expect(withoutTopMeshes).not.toEqual(contents);
    await writeFile(stalePath, withoutTopMeshes, "utf8");

    const stale = await runGenerator(["--check", "--root", scratch]);
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain("oss/packages/mcp/README.md");
    expect(stale.stderr).toContain("pnpm gen:docs");

    // And writing (no `--check`) repairs the copy.
    const repair = await runGenerator(["--root", scratch]);
    expect(repair.code, repair.stderr).toBe(0);
    expect(await readFile(stalePath, "utf8")).toEqual(contents);
  }, 60_000);
});

/**
 * Generated-block marker hygiene (#370).
 *
 * The generator replaces the text *between* a block's `:start` and `:end`
 * markers. The wave-2 integration merge (#367) left a second
 * `generated:registry-query-reference:end` in `api/query.mdx` with a stale copy
 * of the old table behind it: the generator stopped at the first `:end`, so
 * `--check` compared only the first span and called the file up to date while
 * contradictory content sat a few lines below. Anything that makes a block's
 * span ambiguous is therefore an error, not a best-effort rewrite.
 *
 * Each case corrupts one copy of a real target file under `--root`, so the
 * committed files are never touched, and asserts that both `--check` and the
 * writing mode refuse it by name.
 */
describe("gen-registry-docs marker validation (#370)", () => {
  /** An `.md` target (HTML-comment markers) and an `.mdx` one (JSX comments). */
  const MD_TARGET = "oss/packages/mcp/AGENTS.md";
  const MDX_TARGET = "oss/apps/docs/src/content/docs/guides/agents.mdx";

  /** A throwaway copy of every generated file, for one test to corrupt. */
  async function copyTargets(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "uptimizr-gen-markers-"));
    corrupted.push(dir);
    for (const file of GENERATED_FILES) {
      const destination = path.join(dir, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(REPO_ROOT, file), destination);
    }
    return dir;
  }

  /**
   * Corrupt one file's markers, then assert both modes refuse it.
   *
   * `--check` has to fail too: a check that passes on an ambiguous file is the
   * exact bug #370 describes.
   */
  async function expectRefused(
    target: string,
    mutate: (contents: string) => string,
    ...expected: string[]
  ): Promise<void> {
    const dir = await copyTargets();
    const file = path.join(dir, target);
    const original = await readFile(file, "utf8");
    const mutated = mutate(original);
    expect(mutated, "the fixture must actually change the file").not.toEqual(original);
    await writeFile(file, mutated, "utf8");

    for (const args of [["--check"], []]) {
      const result = await runGenerator([...args, "--root", dir]);
      expect(result.code, `expected a failure, got:\n${result.stdout}`).not.toBe(0);
      for (const fragment of [target, ...expected]) expect(result.stderr).toContain(fragment);
    }

    // Refusing means refusing to write: the file is left exactly as it was.
    expect(await readFile(file, "utf8")).toEqual(mutated);
  }

  it("accepts the committed files, whose markers are well formed", async () => {
    const dir = await copyTargets();
    const result = await runGenerator(["--check", "--root", dir]);
    expect(result.code, result.stderr).toBe(0);
  }, 60_000);

  it("rejects a duplicated `:end` marker — the #367 regression", async () => {
    await expectRefused(
      MD_TARGET,
      (contents) =>
        contents.replace(
          "<!-- generated:registry-tool-names:end -->",
          "<!-- generated:registry-tool-names:end -->\n\nstale leftovers\n\n<!-- generated:registry-tool-names:end -->",
        ),
      "2 `generated:registry-tool-names:end` markers",
      "expected exactly one",
    );
  }, 60_000);

  it("rejects a duplicated `:start` marker", async () => {
    await expectRefused(
      MD_TARGET,
      (contents) =>
        contents.replace(
          "<!-- generated:registry-skill-names:start",
          "<!-- generated:registry-skill-names:start (a stray copy) -->\n\n<!-- generated:registry-skill-names:start",
        ),
      "2 `generated:registry-skill-names:start` markers",
      "expected exactly one",
    );
  }, 60_000);

  it("rejects an `:end` with no matching `:start`", async () => {
    await expectRefused(
      MD_TARGET,
      (contents) =>
        contents.replace(/<!-- generated:registry-tool-names:start[^>]*-->/, "(marker removed)"),
      "`generated:registry-tool-names:end`",
      "has no matching `:start` marker",
    );
  }, 60_000);

  it("rejects a `:start` with no matching `:end`", async () => {
    await expectRefused(
      MD_TARGET,
      (contents) => contents.replace("<!-- generated:registry-tool-names:end -->", "(gone)"),
      "`generated:registry-tool-names:start`",
      "has no matching `:end` marker",
    );
  }, 60_000);

  it("rejects an `:end` that comes before its `:start`", async () => {
    await expectRefused(
      MD_TARGET,
      (contents) => {
        const start = /<!-- generated:registry-tool-names:start[^>]*-->/.exec(contents)!;
        const end = "<!-- generated:registry-tool-names:end -->";
        // Swap the pair: same two markers, wrong order.
        return contents
          .replace(start[0], "@@START@@")
          .replace(end, start[0])
          .replace("@@START@@", end);
      },
      "comes before",
    );
  }, 60_000);

  it("rejects nested blocks — one section opening inside another", async () => {
    await expectRefused(
      MD_TARGET,
      (contents) =>
        contents
          .replace(/<!-- generated:registry-skill-names:start[^>]*-->/, "(moved)")
          .replace(
            "<!-- generated:registry-tool-names:end -->",
            "<!-- generated:registry-skill-names:start (nested) -->\n\n<!-- generated:registry-tool-names:end -->",
          ),
      "sections overlap",
    );
  }, 60_000);

  it("rejects a marker naming a block the file does not declare", async () => {
    await expectRefused(
      MDX_TARGET,
      (contents) =>
        contents.replace(
          "{/* generated:registry-skills:end */}",
          "{/* generated:registry-skills:end */}\n\n{/* generated:registry-tools:start (nothing owns this) */}\n\n{/* generated:registry-tools:end */}",
        ),
      "`generated:registry-tools:start`",
      "does not declare",
    );
  }, 60_000);
});
