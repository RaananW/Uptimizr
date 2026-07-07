import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The panel contract (ADR 0036) exposes the collector connection two ways: the
// data seam (`ctx.api` / `ctx.live`) and the raw transport (`ctx.baseUrl` /
// `ctx.apiKey`). A portable panel must consume the SEAM — a host that backs
// `ctx.api` (e.g. cookie-authed hosted reads with an empty baseUrl/apiKey) can
// then reuse the panel verbatim instead of forking a same-id substitute.
//
// This is a static assertion over the catalog source: no catalog panel may read
// `ctx.baseUrl` / `ctx.apiKey`, nor construct its own `CollectorApi` — all data
// must flow through the injected `ctx.api` / `ctx.live`.

// vitest runs with cwd at the package root, so the catalog source lives here.
const CATALOG_DIR = resolve(process.cwd(), "src/catalog");

function catalogSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...catalogSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("catalog data plane (ADR 0036 / ADR 0049)", () => {
  const files = catalogSourceFiles(CATALOG_DIR);

  it("scans the whole catalog source tree", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no catalog panel reads ctx.baseUrl or ctx.apiKey", () => {
    const offenders = files.filter((file) => {
      const src = readFileSync(file, "utf8");
      return /\bctx\.(baseUrl|apiKey)\b/.test(src);
    });
    expect(offenders, `panels must consume ctx.api / ctx.live, not raw transport`).toEqual([]);
  });

  it("no catalog panel constructs its own CollectorApi (transport is injected)", () => {
    const offenders = files.filter((file) => {
      const src = readFileSync(file, "utf8");
      return /new\s+CollectorApi\s*\(/.test(src);
    });
    expect(offenders, `panels must use the injected ctx.api, not build a client`).toEqual([]);
  });
});
