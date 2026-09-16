/**
 * Browser-safety gate (ADR 0050 §1, AGENTS.md "Browser-safe").
 *
 * The catalog is generated from the metric registry, which lives in
 * `@uptimizr/db` — a package whose **root** barrel is Node-only (it owns the
 * DuckDB store). The registry ships on its own dependency-free
 * `@uptimizr/db/registry` subpath precisely so this package can read it without
 * dragging the driver in, and this test is what keeps that true: it bundles the
 * package entry points for the browser with esbuild and fails if a `node:`
 * built-in, the DuckDB driver, or any other Node-only module reaches the bundle.
 *
 * With `platform: "browser"` esbuild refuses to resolve a `node:` built-in at
 * all, so a successful bundle is itself the proof; the assertions then pin that
 * no driver module specifier survived and that the catalog really is in there.
 *
 * esbuild resolves through the same `exports` maps a consumer's bundler would,
 * so this exercises the published surface, not the source tree.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entry = (file: string) => resolve(here, "../..", file);

/** Bundle one entry point for the browser and return the emitted JavaScript. */
async function bundleForBrowser(file: string): Promise<string> {
  const result = await build({
    entryPoints: [entry(file)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    // Browser-only globals the assistant feature-detects; not Node.
    target: "es2022",
    // Optional peer: consumers who use the local backend install it themselves.
    external: ["@mlc-ai/web-llm"],
    logLevel: "silent",
  });
  return result.outputFiles.map((f) => f.text).join("\n");
}

describe("browser safety", () => {
  it("bundles the package entry for the browser with no Node-only module", async () => {
    const code = await bundleForBrowser("src/index.ts");
    expect(code).not.toMatch(/require\(["']node:/);
    expect(code).not.toMatch(/from\s*["']node:/);
    expect(code).not.toContain("@duckdb/");
  }, 60_000);

  it("pulls in the registry subpath, never the Node-only @uptimizr/db root", async () => {
    const code = await bundleForBrowser("src/registryTools.ts");
    expect(code).not.toMatch(/from\s*["']node:/);
    expect(code).not.toContain("@duckdb/");
    // A symbol only the DuckDB store defines — proof the root barrel stayed out.
    expect(code).not.toContain("createDuckDbStore");
    expect(code).toContain("METRIC_REGISTRY");
    // The generated catalog really is in there.
    expect(code).toContain("dead_clicks");
  }, 60_000);
});
