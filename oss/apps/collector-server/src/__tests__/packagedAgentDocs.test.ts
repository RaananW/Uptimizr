/**
 * Packaged agent docs (ADR 0017) — every publishable package ships `AGENTS.md`
 * and `llms.txt` **in its npm tarball**.
 *
 * ADR 0017 makes consumer-facing agent knowledge a shipped product surface: the
 * guide has to travel with the package, not live only in the repo. Two things
 * have to be true for that, and both are easy to forget when adding a package:
 *
 * 1. the files exist next to the `package.json`, and
 * 2. they are listed in the package's `files` array — npm packs nothing else,
 *    so a file that exists but is unlisted never reaches a consumer.
 *
 * This suite walks every workspace package (the `packages:` globs in
 * `pnpm-workspace.yaml`) and asserts both for each one with `private !== true`.
 * It is the regression gate for the ADR 0017 backlog: a new publishable package
 * without a packaged agent guide fails here rather than shipping without one.
 *
 * It lives in `@uptimizr/collector-server` because that is where the repo-level
 * script/policy suites live (see `genRegistryDocs.test.ts`); it reads only
 * `package.json` files and directory entries, so it needs no build output.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Repo root, four levels up from `oss/apps/collector-server/src/__tests__`. */
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

/** Workspace roots — mirrors the `packages:` globs in `pnpm-workspace.yaml`. */
const WORKSPACE_ROOTS = ["oss/apps", "oss/packages", "examples"];

/** The packaged agent-knowledge files ADR 0017 requires. */
const REQUIRED_FILES = ["AGENTS.md", "llms.txt"] as const;

interface WorkspacePackage {
  /** Package name from its `package.json`. */
  name: string;
  /** Directory relative to the repo root, e.g. `oss/packages/sdk-three`. */
  dir: string;
  /** The `files` allow-list npm packs, or `undefined` when unset. */
  files: string[] | undefined;
}

/** Every non-private workspace package, discovered from the filesystem. */
function publishablePackages(): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];

  for (const root of WORKSPACE_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    if (!existsSync(absRoot)) continue;

    for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${root}/${entry.name}`;
      const manifestPath = path.join(REPO_ROOT, dir, "package.json");
      if (!existsSync(manifestPath)) continue;

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: string;
        private?: boolean;
        files?: string[];
      };
      if (!manifest.name || manifest.private === true) continue;

      found.push({ name: manifest.name, dir, files: manifest.files });
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const PACKAGES = publishablePackages();

describe("packaged agent docs (ADR 0017)", () => {
  it("discovers the publishable workspace packages", () => {
    // A guard on the walker itself: if the globs or the layout ever change so
    // that nothing is found, the per-package assertions below would vacuously
    // pass and the gate would silently stop gating.
    expect(PACKAGES.length).toBeGreaterThan(0);
    expect(PACKAGES.map((pkg) => pkg.name)).toContain("@uptimizr/collector-server");
  });

  it.each(PACKAGES)("$name ships AGENTS.md and llms.txt in its tarball", (pkg) => {
    for (const file of REQUIRED_FILES) {
      expect(
        existsSync(path.join(REPO_ROOT, pkg.dir, file)),
        `${pkg.name}: ${pkg.dir}/${file} is missing (ADR 0017 requires a packaged agent guide)`,
      ).toBe(true);

      expect(
        pkg.files ?? [],
        `${pkg.name}: "${file}" is not in the package.json "files" array, so npm would not pack it`,
      ).toContain(file);
    }
  });
});
