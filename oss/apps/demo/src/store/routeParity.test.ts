import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_SPECIAL_GET_ROUTES, READ_ROUTES } from "./collectorStore.js";

/**
 * Drift guard for the in-browser collector (ADR 0004 self-contained demo).
 *
 * `collectorStore.ts` re-implements the collector's read API inside the browser
 * so the demo needs no backend. That makes it a hand-maintained mirror of the
 * Fastify routes in `oss/apps/collector-server/src/routes/query.ts`, and the two
 * have silently drifted before (newly added panels 404'd in the demo). This test
 * diffs the demo's coverage against the collector's GET routes so any new — or
 * removed — read endpoint fails CI until the demo is updated to match.
 *
 * The collector's `query.ts` is the source of truth: we read it as text (a sibling
 * file in the monorepo, not a package dependency, so the backend-less demo keeps
 * its clean dep graph) and extract every `r.get("/api/v1/…")` registration.
 */
const here = dirname(fileURLToPath(import.meta.url));
const QUERY_ROUTES_SRC = resolve(here, "../../../collector-server/src/routes/query.ts");

/** Every `*.get("/api/v1/…")` route path registered in the collector's query API. */
function collectorGetRoutes(): Set<string> {
  const src = readFileSync(QUERY_ROUTES_SRC, "utf8");
  const re = /\.get\(\s*["'`](\/api\/v1\/[^"'`]+)["'`]/g;
  const routes = new Set<string>();
  for (const match of src.matchAll(re)) routes.add(match[1]!);
  return routes;
}

/** Routes the demo serves: builder table + the hand-rolled session/scene handlers. */
const demoCovered = new Set<string>([...Object.keys(READ_ROUTES), ...DEMO_SPECIAL_GET_ROUTES]);

describe("demo collector route parity (vs collector-server query.ts)", () => {
  const collector = collectorGetRoutes();

  it("parses a sane number of collector read routes (guards the extractor)", () => {
    // If the regex ever stops matching, this trips before a false green below.
    expect(collector.size).toBeGreaterThan(30);
  });

  it("mirrors every collector GET read route in the demo", () => {
    const missingInDemo = [...collector].filter((path) => !demoCovered.has(path)).sort();
    expect(missingInDemo).toEqual([]);
  });

  it("serves no stale routes the collector no longer exposes", () => {
    const staleInDemo = [...demoCovered].filter((path) => !collector.has(path)).sort();
    expect(staleInDemo).toEqual([]);
  });
});
