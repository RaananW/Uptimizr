/**
 * `POST /api/v1/query` and `GET /api/v1/query?q=` end to end (ADR 0051 §3,
 * design sketch §C.3).
 *
 * A real collector over a real DuckDB store seeded with the parity fixtures, so
 * the numbers below are the numbers the canned endpoints return — which is the
 * point of the delegated tier and the thing a mock could not show.
 *
 * What it gates:
 *
 * - the two transports answer identically, because they are the same document;
 * - **every** registry aggregation is reachable through the endpoint (acceptance
 *   criterion 1), and its rows match the canned endpoint's byte for byte;
 * - the four ways a query can be wrong are `400`s whose message names what the
 *   metric *does* accept, rather than an empty result the agent would believe;
 * - `format` is honoured, with `table` as the DSL's default;
 * - it needs the `query` capability, and it is audited with the query — not with
 *   an empty querystring, which is all the POST form would otherwise record.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PARITY_EVENTS, PARITY_PROJECT_ID, PARITY_RANGE } from "@uptimizr/db";
import { allMetrics, isResourceMetric, requiredFilters } from "@uptimizr/metrics";
import type { ApiKeyCapability } from "@uptimizr/db";
import { buildApp } from "../app.js";
import { createDuckdbStore } from "../duckdbStore.js";
import type { CollectorStore } from "../store.js";
import { TEST_CONFIG as config, TEST_PROXY as PROXY } from "./support/registryRequests.js";

const QUERY_KEY = "query-dsl-key";
const INGEST_KEY = "query-dsl-ingest-key";

/** Values for the filters a metric cannot be queried without. */
const REQUIRED_VALUES: Readonly<Record<string, unknown>> = {
  session: "s1",
  scene: "lobby",
  mesh: "box",
  steps: [{ type: "camera_sample" }, { type: "pointer_click", mesh: "sphere" }],
};

// Everything `POST /api/v1/query` can compile: a metric with a `build*`. The
// two resource reads have none, and neither do the derived insight primitives
// (#305) — they are computed over another metric's bucket series and are served
// on `/api/v1/insights/*`, which is what their 400 says.
const AGGREGATIONS = allMetrics().filter((metric) => metric.builder !== undefined);

let app: FastifyInstance;

beforeAll(async () => {
  const base = await createDuckdbStore(":memory:");
  await base.insertEvents(PARITY_EVENTS);
  await base.putSceneProxy(PARITY_PROJECT_ID, PROXY, "Main Lobby");
  await base.putSceneRegions(PARITY_PROJECT_ID, "lobby", [
    { id: "entrance", label: "Entrance", bounds: [-2, 0, -2, 0, 3, 0] },
  ]);
  const store: CollectorStore = {
    ...base,
    resolveApiKey: async (key) => {
      const capabilities: ApiKeyCapability[] | null =
        key === QUERY_KEY ? ["query"] : key === INGEST_KEY ? ["ingest"] : null;
      if (!capabilities) return null;
      return {
        projectId: PARITY_PROJECT_ID,
        keyId: `${key}-id`,
        capabilities,
        label: null,
        rateLimit: null,
      };
    },
  };
  app = await buildApp({ store, config });
});

afterAll(async () => {
  await app?.close();
});

/** POST a query document. */
function post(body: unknown, key = QUERY_KEY) {
  return app.inject({
    method: "POST",
    url: "/api/v1/query",
    headers: { "x-api-key": key },
    payload: body as Record<string, unknown>,
  });
}

/** The same query through the GET transport. */
function get(body: unknown, key = QUERY_KEY) {
  return app.inject({
    method: "GET",
    url: `/api/v1/query?q=${encodeURIComponent(JSON.stringify(body))}`,
    headers: { "x-api-key": key },
  });
}

/**
 * Rows in a stable order. DuckDB does not promise an order between tied rows
 * (every mesh in the fixtures has the same count), so comparing content means
 * canonicalising first — the same reason `resultFormat.test.ts` does it.
 */
function sorted(rows: unknown): unknown[] {
  return [...(rows as Record<string, unknown>[])].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

/** A minimal query for `metric`, with whatever it declares as required. */
function query(metric: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const definition = allMetrics().find((m) => m.id === metric);
  const filters: Record<string, unknown> = {};
  // An unknown metric declares nothing; the point of such a query is the 400.
  for (const id of definition ? requiredFilters(definition) : []) {
    filters[id] = REQUIRED_VALUES[id];
  }
  const extraFilters = (extra.filters ?? {}) as Record<string, unknown>;
  const merged = { ...filters, ...extraFilters };
  return {
    v: 1,
    metric,
    range: PARITY_RANGE,
    ...extra,
    ...(Object.keys(merged).length > 0 ? { filters: merged } : {}),
  };
}

describe("POST /api/v1/query", () => {
  it("answers a breakdown with the table envelope by default", async () => {
    const res = await post(query("top_meshes"));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { meta: Record<string, unknown>; rows: unknown[] };
    expect(body.meta.metric).toBe("top_meshes");
    expect(body.meta.range).toEqual({ since: PARITY_RANGE.since, until: PARITY_RANGE.until });
    expect(body.meta.truncated).toBe(false);
    expect(sorted(body.rows)).toEqual([
      { mesh: "box", count: 2 },
      { mesh: "floor", count: 2 },
      { mesh: "sphere", count: 2 },
    ]);
  });

  it("returns the bare rows for format=full and a digest for format=summary", async () => {
    const full = await post(query("top_meshes", { format: "full" }));
    expect(sorted(full.json())).toEqual([
      { mesh: "box", count: 2 },
      { mesh: "floor", count: 2 },
      { mesh: "sphere", count: 2 },
    ]);

    const summary = await post(query("top_meshes", { format: "summary" }));
    const body = summary.json() as { kind: string; metric: string; reading: string; total: number };
    expect(body.kind).toBe("ranked");
    expect(body.metric).toBe("top_meshes");
    expect(body.total).toBe(6);
    expect(body.reading.length).toBeGreaterThan(0);
  });

  it("applies a filter, and the filtered answer is narrower than the unfiltered one", async () => {
    const all = await post(query("mesh_sources", { format: "full" }));
    const filtered = await post(
      query("mesh_sources", { format: "full", filters: { mesh: undefined, source: "mouse" } }),
    );
    expect(filtered.statusCode).toBe(200);
    expect(sorted(filtered.json())).toEqual([
      { mesh: "box", source: "mouse", count: 1 },
      { mesh: "floor", source: "mouse", count: 1 },
      { mesh: "sphere", source: "mouse", count: 1 },
    ]);
    expect((all.json() as unknown[]).length).toBeGreaterThanOrEqual(
      (filtered.json() as unknown[]).length,
    );
  });

  it("honours the row cap", async () => {
    const res = await post(query("top_meshes", { limit: 1 }));
    const body = res.json() as { meta: { truncated: boolean }; rows: unknown[] };
    expect(body.rows).toHaveLength(1);
    expect(body.meta.truncated).toBe(true);
  });

  it("resolves a registered region id to its bounds before the aggregation runs", async () => {
    const res = await post(
      query("world_heatmap", { format: "full", filters: { scene: "lobby", region: "entrance" } }),
    );
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("rejects a region id the project never registered rather than answering 'no hits'", async () => {
    const res = await post(
      query("world_heatmap", { filters: { scene: "lobby", region: "nowhere" } }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("nowhere");
  });
});

describe("GET /api/v1/query", () => {
  it("answers identically to the POST form", async () => {
    const document = query("top_meshes");
    const viaPost = await post(document);
    const viaGet = await get(document);
    expect(viaGet.statusCode).toBe(200);
    const asPosted = viaPost.json() as { meta: unknown; rows: unknown[] };
    const asGot = viaGet.json() as { meta: unknown; rows: unknown[] };
    expect(asGot.meta).toEqual(asPosted.meta);
    expect(sorted(asGot.rows)).toEqual(sorted(asPosted.rows));
  });

  it("rejects a q that is not JSON", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/query?q=not-json",
      headers: { "x-api-key": QUERY_KEY },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("not valid JSON");
  });

  it("rejects a q above the size cap before parsing it", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/query?q=${"x".repeat(9000)}`,
      headers: { "x-api-key": QUERY_KEY },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("the 400s name what would have worked", () => {
  it("an unknown metric", async () => {
    const res = await post(query("top_mehses"));
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; issues: { code: string }[] };
    expect(body.issues[0]?.code).toBe("unknown_metric");
    expect(body.error).toContain("top_mehses");
  });

  it("a dimension the metric is not keyed by and cannot be regrouped onto", async () => {
    // `pointer_heatmap` bins screen coordinates: its measure *is* the binning,
    // so there is no generic tier to move it to (#304).
    const res = await post(query("pointer_heatmap", { dimensions: ["session"] }));
    expect(res.statusCode).toBe(400);
    const body = res.json() as { issues: { code: string; accepted?: string[] }[] };
    expect(body.issues[0]?.code).toBe("dimension_not_native");
  });

  it("a filter the metric does not accept, listing the ones it does", async () => {
    const res = await post(query("top_meshes", { filters: { scene: "lobby" } }));
    expect(res.statusCode).toBe(400);
    const body = res.json() as { issues: { code: string; path: string; accepted?: string[] }[] };
    expect(body.issues[0]?.code).toBe("unsupported_filter");
    expect(body.issues[0]?.path).toBe("filters.scene");
    expect(body.issues[0]?.accepted).toContain("session");
  });

  it("a malformed document, without ever reaching the store", async () => {
    const res = await post({ metric: "top_meshes" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("queryV1");
  });

  it("an event predicate on a metric with no generic tier", async () => {
    const res = await post(
      query("pointer_heatmap", { filters: { event: { type: "mesh_interaction" } } }),
    );
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; issues: { code: string }[] };
    expect(body.issues[0]?.code).toBe("unsupported_feature");
    expect(body.error).toContain("generic group-by tier");
  });

  it("an order on a column that is not a measure", async () => {
    const res = await post(query("top_meshes", { order: { by: "mesh", dir: "asc" } }));
    expect(res.statusCode).toBe(400);
    const body = res.json() as { issues: { code: string; accepted?: string[] }[] };
    expect(body.issues[0]?.code).toBe("unsupported_order");
    expect(body.issues[0]?.accepted).toContain("count");
  });

  it("reports every objection at once, so one round trip is enough", async () => {
    const res = await post(
      query("top_meshes", {
        dimensions: ["device.isMobile"],
        filters: { scene: "lobby" },
        order: { by: "mesh", dir: "asc" },
      }),
    );
    const body = res.json() as { issues: { code: string }[] };
    expect(body.issues.map((issue) => issue.code).sort()).toEqual([
      "unknown_dimension",
      "unsupported_filter",
      "unsupported_order",
    ]);
  });
});

describe("auth and audit", () => {
  it("requires a key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/query",
      payload: query("top_meshes"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("requires the query capability on both transports", async () => {
    expect((await post(query("top_meshes"), INGEST_KEY)).statusCode).toBe(403);
    expect((await get(query("top_meshes"), INGEST_KEY)).statusCode).toBe(403);
  });

  it("records the query in the audit trail, not an empty querystring", async () => {
    await post(query("mesh_sources", { filters: { mesh: undefined, source: "mouse" } }));
    // The audit row is written from an `onResponse` hook, so give the
    // fire-and-forget write a turn of the event loop to land.
    await new Promise((resolve) => setImmediate(resolve));
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/audit?limit=50",
      headers: { "x-api-key": QUERY_KEY },
    });
    const rows = res.json() as { toolOrPath: string; params: string }[];
    const entry = rows.find((row) => row.toolOrPath === "/api/v1/query");
    expect(entry).toBeDefined();
    expect(entry?.params).toContain("mesh_sources");
    expect(entry?.params).toContain("mouse");
  });
});

describe("every registry aggregation is reachable through the DSL", () => {
  it.each(AGGREGATIONS.map((metric) => metric.id))("%s answers 200", async (id) => {
    const res = await post(query(id, { format: "full" }));
    expect(res.statusCode, res.body).toBe(200);
  });

  it.each(["insight_baseline", "insight_movers"])(
    "%s answers 400, naming the endpoint that does serve it",
    async (id) => {
      const res = await post(query(id, { format: "full" }));
      expect(res.statusCode).toBe(400);
      const body = res.json() as { issues?: { code: string }[]; error?: string };
      expect(body.issues?.[0]?.code).toBe("metric_not_queryable");
      expect(body.error).toContain("/api/v1/insights/");
    },
  );

  it("returns exactly what the canned endpoint returns", async () => {
    // Three metrics whose canned endpoints take no parameter the DSL spells
    // differently, so the two requests are the same question by construction.
    for (const id of ["top_meshes", "event_counts", "perf_summary"]) {
      const metric = allMetrics().find((m) => m.id === id)!;
      const canned = await app.inject({
        method: "GET",
        url: `${metric.endpoint!.path}?since=${PARITY_RANGE.since}&until=${PARITY_RANGE.until}`,
        headers: { "x-api-key": QUERY_KEY },
      });
      const dsl = await post(query(id, { format: "full" }));
      expect(sorted(dsl.json()), id).toEqual(sorted(canned.json()));
    }
  });
});
