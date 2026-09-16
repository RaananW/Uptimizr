/**
 * **Negative dependency gate (ADR 0050, ADR 0051 §1).**
 *
 * `@uptimizr/mcp` is launched with `npx @uptimizr/mcp` from a desktop AI client,
 * so its install must be small and architecture-independent. It talks to a
 * collector over HTTP and never opens a database itself — but it used to depend
 * on `@uptimizr/db` for the metric registry, which pulls in `@duckdb/node-api`,
 * a ~37 MB native binding this server can never use. The registry now lives in
 * `@uptimizr/metrics`, which depends only on `zod` and `@uptimizr/schema`.
 *
 * This test fails if that regresses: it reads this package's own manifest, walks
 * the **workspace** dependency graph from it (following `workspace:*` edges by
 * reading each package's `package.json` off disk — no install required), and
 * fails when `@uptimizr/db` or any package known to ship a native or optional
 * platform binary is reachable through `dependencies` / `peerDependencies`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
/** This package's root (…/oss/packages/mcp). */
const packageRoot = resolve(here, "../..");
/** The monorepo root (the directory holding `pnpm-workspace.yaml`). */
const repoRoot = resolve(packageRoot, "../../..");

/** The package this suite guards. */
const SELF = "@uptimizr/mcp";

/**
 * Packages that ship (or optionally install) a platform binary. Depending on one
 * of these — directly or through a workspace package — makes an install fetch
 * megabytes of architecture-specific code, which is exactly what an
 * `npx`-launched server must not do.
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
  for (const dir of ["oss/packages", "oss/apps"]) {
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

  it("declares only HTTP-and-data runtime packages", () => {
    expect(runtimeDeps(self as Manifest).sort()).toEqual([
      "@modelcontextprotocol/sdk",
      "@uptimizr/agent-core",
      "@uptimizr/metrics",
      "@uptimizr/schema",
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
