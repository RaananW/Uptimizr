/**
 * The registry docs generator (`scripts/gen-registry-docs.mjs`, issue #297).
 *
 * The endpoint/tool tables in `docs/integration.md`, the docs site and the
 * packaged `README`/`AGENTS.md`/`llms.txt` are rendered from the metric registry,
 * so this suite proves the staleness gate actually works:
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

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
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
