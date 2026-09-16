/**
 * **Negative dependency gate (ADR 0050, ADR 0051 §1).**
 *
 * `@uptimizr/agent-core` is browser-safe and is a dependency of
 * `@uptimizr/react`, so `npm i @uptimizr/react` must never download a database
 * driver. It used to depend on `@uptimizr/db` for the metric registry, which
 * pulls in `@duckdb/node-api` — a ~37 MB native binding no browser consumer can
 * load. The registry now lives in `@uptimizr/metrics`, which depends only on
 * `zod` and `@uptimizr/schema`.
 *
 * This test fails if that regresses: it reads this package's own manifest, walks
 * the **workspace** dependency graph from it (following `workspace:*` edges by
 * reading each package's `package.json` off disk — no install required), and
 * fails when `@uptimizr/db` or any package known to ship a native or optional
 * platform binary is reachable through `dependencies` / `peerDependencies`.
 *
 * Its companion `browserSafety.test.ts` proves the same thing from the other
 * side, by actually bundling the package for the browser.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
/** This package's root (…/oss/packages/agent-core). */
const packageRoot = resolve(here, "../..");
/** The monorepo root (the directory holding `pnpm-workspace.yaml`). */
const repoRoot = resolve(packageRoot, "../../..");

/** The package this suite guards. */
const SELF = "@uptimizr/agent-core";

/**
 * Packages that ship (or optionally install) a platform binary. Depending on one
 * of these — directly or through a workspace package — makes an install fetch
 * megabytes of architecture-specific code, which is exactly what a browser-safe
 * or `npx`-launched package must not do.
 *
 * `@uptimizr/db` is listed by name as well as by its native dependency, because
 * the point of the split is that this package must not reach it *at all*.
 */
const NATIVE_DEPENDENCIES: readonly string[] = [
  "@duckdb/node-api",
  "@duckdb/node-bindings",
  "duckdb",
  "better-sqlite3",
  "sharp",
  "canvas",
  "msnodesqlv8",
  "esbuild",
  "fsevents",
  "node-gyp",
  "prebuild-install",
  "playwright",
  "@playwright/test",
];

/** Workspace packages that are forbidden regardless of what they depend on. */
const FORBIDDEN_WORKSPACE_PACKAGES: readonly string[] = [
  "@uptimizr/db",
  "@uptimizr/db-clickhouse",
  "@uptimizr/db-mssql",
  "@uptimizr/db-postgres",
  "@uptimizr/collector-server",
];

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Every workspace package's manifest, keyed by package name. */
function readWorkspaceManifests(): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  const globs = ["oss/packages", "oss/apps"];
  for (const dir of globs) {
    const base = join(repoRoot, dir);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(base, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      if (manifest.name) manifests.set(manifest.name, manifest);
    }
  }
  return manifests;
}

/** `dependencies` + `peerDependencies` of a manifest, as names. */
function runtimeDeps(manifest: Manifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
}

/**
 * Every package reachable from `root` through `dependencies` /
 * `peerDependencies`, with the path that reached it (for a readable failure).
 */
function reachable(root: string, manifests: Map<string, Manifest>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const queue: Array<{ name: string; path: string[] }> = [{ name: root, path: [root] }];
  while (queue.length > 0) {
    const current = queue.shift() as { name: string; path: string[] };
    const manifest = manifests.get(current.name);
    if (manifest == null) continue; // external package: its own deps are not walked here
    for (const dep of runtimeDeps(manifest)) {
      if (found.has(dep)) continue;
      const path = [...current.path, dep];
      found.set(dep, path);
      queue.push({ name: dep, path });
    }
  }
  return found;
}

describe(`${SELF} — negative dependency gate`, () => {
  const manifests = readWorkspaceManifests();
  const self = manifests.get(SELF);

  it("finds its own workspace manifest", () => {
    expect(self, `${SELF} not found among the workspace manifests`).toBeDefined();
  });

  it("does not declare @uptimizr/db", () => {
    expect(Object.keys(self?.dependencies ?? {})).not.toContain("@uptimizr/db");
    expect(Object.keys(self?.peerDependencies ?? {})).not.toContain("@uptimizr/db");
  });

  it("declares only dependency-free runtime packages", () => {
    expect(runtimeDeps(self as Manifest).sort()).toEqual([
      "@mlc-ai/web-llm",
      "@uptimizr/metrics",
      "zod",
    ]);
  });

  it("cannot reach a store package through any runtime dependency", () => {
    const found = reachable(SELF, manifests);
    for (const forbidden of FORBIDDEN_WORKSPACE_PACKAGES) {
      const path = found.get(forbidden);
      expect(path, `${SELF} reaches ${forbidden} via ${path?.join(" -> ")}`).toBeUndefined();
    }
  });

  it("cannot reach a package with a native or optional binary dependency", () => {
    const found = reachable(SELF, manifests);
    const offenders = NATIVE_DEPENDENCIES.filter((name) => found.has(name)).map(
      (name) => `${name} (via ${found.get(name)?.join(" -> ")})`,
    );
    expect(
      offenders,
      `native dependencies reachable from ${SELF}: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
