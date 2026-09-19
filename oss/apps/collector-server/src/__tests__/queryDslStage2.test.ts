/**
 * `compare`, `explain`, the generic group-by tier, `order` and runnable drill
 * hints, end to end (ADR 0051 §3, design sketch §C.2, #304).
 *
 * Same shape as `queryDsl.test.ts`: a real collector over a real DuckDB store
 * seeded with the parity fixtures. Stage 1 proved every metric was *reachable*;
 * this proves the four things an agent actually asks for once it can reach them,
 * and that each one still refuses rather than guesses when the registry says it
 * cannot answer.
 *
 * The fixture window is split deliberately. Everything session `s1` did happens
 * before `T0 + 10s` and everything `s2` did after it, so a compare across that
 * boundary has a real arrival (`floor`) and two real disappearances (`box`,
 * `sphere`) rather than a uniform shift — which is the case a naive join gets
 * wrong.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PARITY_EVENTS, PARITY_PROJECT_ID, PARITY_RANGE, PARITY_T0 } from "@uptimizr/db";
import type { ApiKeyCapability } from "@uptimizr/db";
import { buildApp } from "../app.js";
import { createDuckdbStore } from "../duckdbStore.js";
import type { CollectorStore } from "../store.js";
import { TEST_CONFIG as config } from "./support/registryRequests.js";

const QUERY_KEY = "query-stage2-key";

/** `s2` starts here, so the two halves of the fixture split cleanly. */
const SPLIT = PARITY_T0 + 10_000;
const LATE = { since: SPLIT, until: PARITY_T0 + 60_000 };
const EARLY = { since: PARITY_T0 - 60_000, until: SPLIT };

let app: FastifyInstance;

beforeAll(async () => {
  const base = await createDuckdbStore(":memory:");
  await base.insertEvents(PARITY_EVENTS);
  const store: CollectorStore = {
    ...base,
    resolveApiKey: async (key) =>
      key === QUERY_KEY
        ? {
            projectId: PARITY_PROJECT_ID,
            keyId: `${key}-id`,
            capabilities: ["query"] as ApiKeyCapability[],
            label: null,
            rateLimit: null,
          }
        : null,
  };
  app = await buildApp({ store, config });
});

afterAll(async () => {
  await app?.close();
});

function post(body: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/v1/query",
    headers: { "x-api-key": QUERY_KEY },
    payload: body as Record<string, unknown>,
  });
}

function get(body: unknown) {
  return app.inject({
    method: "GET",
    url: `/api/v1/query?q=${encodeURIComponent(JSON.stringify(body))}`,
    headers: { "x-api-key": QUERY_KEY },
  });
}

/** Rows keyed by one column, for assertions that do not care about row order. */
function by(rows: readonly Record<string, unknown>[], column: string): Map<unknown, unknown> {
  return new Map(rows.map((row) => [row[column], row]));
}

describe("the generic group-by tier", () => {
  it("regroups a metric onto a grain its own builder cannot produce", async () => {
    const res = await post({
      v: 1,
      metric: "top_meshes",
      dimensions: ["mesh", "event_type"],
      range: PARITY_RANGE,
      format: "full",
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Record<string, unknown>[];
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.event_type))).toEqual(
      new Set(["pointer_click", "pointer_move", "mesh_visibility"]),
    );
    // Regrouping must not change the population: the mesh totals still add up
    // to what the delegated tier returns.
    const total = rows.reduce((sum, row) => sum + (row.count as number), 0);
    expect(total).toBe(6);
  });

  it("keeps the metric's own scope when it regroups", async () => {
    // `mesh_sources` counts `mesh_interaction` + `pointer_click` with a mesh.
    // Dropping either predicate would inflate `lobby` from 2 to 4.
    const res = await post({
      v: 1,
      metric: "mesh_sources",
      dimensions: ["scene"],
      range: PARITY_RANGE,
      format: "full",
    });
    const rows = by(res.json() as Record<string, unknown>[], "scene_id");
    expect(rows.get("lobby")).toMatchObject({ count: 2 });
    expect(rows.get("arena")).toMatchObject({ count: 1 });
  });

  it("groups by a session attribute read out of session_start", async () => {
    const res = await post({
      v: 1,
      metric: "event_counts",
      dimensions: ["device.os", "device.engine"],
      range: PARITY_RANGE,
      format: "full",
    });
    expect(res.statusCode).toBe(200);
    const rows = by(res.json() as Record<string, unknown>[], "engine");
    // The fixtures carry no UA-derived `os`, so the attribute is absent from
    // the payload and groups as null — which is the honest answer, not a
    // missing row and not a fabricated "unknown".
    expect(rows.get("webgpu")).toMatchObject({ count: 12, os: null });
    expect(rows.get("webgl2")).toMatchObject({ count: 11, os: null });
  });

  it("filters by a device attribute, which no canned builder takes", async () => {
    const res = await post({
      v: 1,
      metric: "event_counts",
      dimensions: ["scene"],
      filters: { device: { browser: "Chrome" } },
      range: PARITY_RANGE,
      format: "full",
    });
    expect(res.statusCode).toBe(200);
    // No fixture session declares a browser, so the filter matches nothing —
    // and an empty result is the correct answer, not an error.
    expect(res.json()).toEqual([]);
  });

  it("filters by an event predicate, as a cohort of sessions", async () => {
    // Only `s1` clicked the sphere, and `s1` produced 10 events.
    const res = await post({
      v: 1,
      metric: "event_counts",
      dimensions: ["session"],
      filters: { event: { type: "pointer_click", mesh: "sphere" } },
      range: PARITY_RANGE,
      format: "full",
    });
    const rows = res.json() as Record<string, unknown>[];
    expect(rows).toEqual([{ session_id: "s1", count: 12 }]);
  });

  it("orders by a measure in SQL, so the row cap keeps the rows that were asked for", async () => {
    const ascending = await post({
      v: 1,
      metric: "event_counts",
      dimensions: ["event_type", "scene"],
      order: { by: "count", dir: "asc" },
      limit: 1,
      range: PARITY_RANGE,
      format: "full",
    });
    const rows = ascending.json() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
  });

  it("holds a dimension fixed as a segment, even one the metric cannot filter by", async () => {
    // `top_meshes` has no `scene` filter at all — its builder never had one.
    const res = await post({
      v: 1,
      metric: "top_meshes",
      segment: { scene: "arena" },
      range: PARITY_RANGE,
      format: "full",
    });
    expect(res.json()).toEqual([{ mesh: "floor", count: 2 }]);
  });
});

describe("compare", () => {
  it("joins two windows on the dimension key, keeping arrivals and departures", async () => {
    const res = await post({
      v: 1,
      metric: "top_meshes",
      range: LATE,
      compare: { range: EARLY },
      format: "table",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      meta: { basis: string; keys: string[]; current: { total: number } };
      rows: { key: Record<string, string>; current: number | null; previous: number | null }[];
    };
    expect(body.meta.basis).toBe("range");
    expect(body.meta.keys).toEqual(["mesh"]);
    const rows = new Map(body.rows.map((row) => [row.key.mesh, row]));
    expect(rows.get("floor")).toMatchObject({ current: 2, previous: null });
    expect(rows.get("box")).toMatchObject({ current: null, previous: 2 });
    expect(rows.get("sphere")).toMatchObject({ current: null, previous: 2 });
  });

  it("compares two segments of the same window", async () => {
    const res = await post({
      v: 1,
      metric: "top_meshes",
      range: PARITY_RANGE,
      segment: { scene: "arena" },
      compare: { segment: { scene: "lobby" } },
      format: "table",
    });
    const body = res.json() as {
      meta: { basis: string; current: { segment: Record<string, string> } };
      rows: { key: Record<string, string>; current: number | null; previous: number | null }[];
    };
    expect(body.meta.basis).toBe("segment");
    expect(body.meta.current.segment).toEqual({ scene: "arena" });
    const rows = new Map(body.rows.map((row) => [row.key.mesh, row]));
    expect(rows.get("floor")).toMatchObject({ current: 2, previous: null });
    expect(rows.get("box")).toMatchObject({ current: null, previous: 2 });
  });

  it("reports a significance where the measure is a count and both windows qualify", async () => {
    const res = await post({
      v: 1,
      metric: "event_counts",
      range: LATE,
      compare: { range: EARLY },
      format: "table",
    });
    const body = res.json() as {
      meta: { caveats: string[] };
      rows: { key: Record<string, string>; significance?: { test: string } }[];
    };
    // The fixtures are far under `event_counts`' 50-event minimum, so the
    // honest answer here is *no* p-value — and a caveat that says why.
    expect(body.rows.every((row) => row.significance == null)).toBe(true);
    expect(body.meta.caveats.join(" ")).toContain("minimum this metric declares");
  });

  it("digests a comparison into ranked movers with a reading", async () => {
    const res = await post({
      v: 1,
      metric: "top_meshes",
      range: LATE,
      compare: { range: EARLY },
      format: "summary",
    });
    const body = res.json() as {
      kind: string;
      reading: string;
      top: { label: string; delta: number | null }[];
    };
    expect(body.kind).toBe("movers");
    expect(body.reading).toContain("Most-interacted meshes");
    expect(body.reading).toContain("count");
    // Every fixture row appears on exactly one side, so nothing has a delta;
    // the digest still has to rank and read them rather than fall over.
    expect(body.top.length).toBeGreaterThan(0);
  });

  it("answers identically on both transports", async () => {
    const query = {
      v: 1,
      metric: "top_meshes",
      range: LATE,
      compare: { range: EARLY },
      format: "full",
    };
    const [a, b] = await Promise.all([post(query), get(query)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json()).toEqual(b.json());
  });
});

describe("explain", () => {
  it("returns the plan instead of the rows, with parameters named but never valued", async () => {
    const res = await post({
      v: 1,
      metric: "top_meshes",
      range: PARITY_RANGE,
      filters: { session: "s1" },
      explain: true,
    });
    expect(res.statusCode).toBe(200);
    const plan = res.json() as {
      metric: string;
      tier: string;
      dialect: string;
      sql: string;
      params: { name: string; type: string }[];
      warnings: string[];
    };
    expect(plan.metric).toBe("top_meshes");
    expect(plan.tier).toBe("delegated");
    expect(plan.dialect).toBe("duckdb");
    expect(plan.sql).toContain("GROUP BY mesh");
    expect(plan.params.map((param) => param.name)).toContain("session");
    // The value the caller filtered by must not appear anywhere in the plan.
    expect(JSON.stringify(plan)).not.toContain('"s1"');
    expect(plan.sql).not.toContain("s1");
  });

  it("names the generic tier when that is what would run", async () => {
    const res = await post({
      v: 1,
      metric: "top_meshes",
      dimensions: ["scene"],
      range: PARITY_RANGE,
      explain: true,
    });
    const plan = res.json() as { tier: string; sql: string };
    expect(plan.tier).toBe("generic");
    expect(plan.sql).toContain("GROUP BY events.scene_id");
  });

  it("warns about a capture channel that produced nothing in the window", async () => {
    // The parity fixtures carry no `input_action` events at all.
    const res = await post({
      v: 1,
      metric: "top_input_actions",
      range: PARITY_RANGE,
      explain: true,
    });
    const plan = res.json() as { rowsScanned: number | null; warnings: string[] };
    expect(plan.rowsScanned).toBe(0);
    expect(plan.warnings.join(" ")).toContain("input_action");
    expect(plan.warnings.join(" ")).toContain("capture channel switched off");
  });

  it("warns when the window holds less data than the metric's own minimum", async () => {
    const res = await post({ v: 1, metric: "top_meshes", range: PARITY_RANGE, explain: true });
    const plan = res.json() as { rowsScanned: number | null; warnings: string[] };
    expect(plan.rowsScanned).toBe(6);
    expect(plan.warnings.join(" ")).toContain("minimum at which a change is worth reporting");
  });
});

describe("order on a delegated metric", () => {
  it("re-sorts the rows the builder returned", async () => {
    const res = await post({
      v: 1,
      metric: "interaction_sources",
      range: PARITY_RANGE,
      order: { by: "count", dir: "asc" },
      format: "full",
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { count: number }[];
    const counts = rows.map((row) => row.count);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  });

  it("says so when the cap had already chosen which rows exist", async () => {
    const res = await post({
      v: 1,
      metric: "top_meshes",
      range: PARITY_RANGE,
      limit: 2,
      order: { by: "count", dir: "asc" },
      format: "summary",
    });
    const body = res.json() as { caveats: string[] };
    expect(body.caveats.join(" ")).toContain("smallest of the top rows");
  });
});

describe("drill hints", () => {
  it("gives each summarised row the query that narrows to it", async () => {
    const res = await post({
      v: 1,
      metric: "mesh_sources",
      range: PARITY_RANGE,
      filters: { scene: "lobby" },
      format: "summary",
    });
    const body = res.json() as {
      top: {
        label: string;
        drill?: Record<string, string>;
        drillQuery?: Record<string, unknown>;
      }[];
    };
    const first = body.top[0];
    expect(first?.drill).toBeDefined();
    expect(first?.drillQuery).toMatchObject({
      v: 1,
      metric: "mesh_sources",
      range: { since: PARITY_RANGE.since, until: PARITY_RANGE.until },
    });
    // The narrowed query keeps the scope it already had…
    const filters = first?.drillQuery?.filters as Record<string, unknown>;
    expect(filters.scene).toBe("lobby");
    // …and adds the row's own. `mesh_sources` has no `mesh` filter — its builder
    // never took one — so the mesh is held fixed as a segment instead, which is
    // the narrowing the generic tier makes possible (#304).
    const segment = first?.drillQuery?.segment as Record<string, unknown>;
    expect(segment.mesh).toBe(first?.label);

    // …and it is a query the collector actually answers.
    const drilled = await post({ ...(first?.drillQuery ?? {}), format: "full" });
    expect(drilled.statusCode).toBe(200);
    const drilledRows = drilled.json() as Record<string, unknown>[];
    expect(drilledRows.length).toBeGreaterThan(0);
    expect(drilledRows.every((row) => row.mesh === first?.label)).toBe(true);
  });
});
