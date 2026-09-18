/**
 * The generic group-by compiler, the comparison join, the plan and the
 * delegated re-order — as **pure** gates (ADR 0051 §3, design sketch §C.2, #304).
 *
 * No database: these assert on the SQL that is rendered and on the rows that are
 * joined, which is where the properties that matter live. That the SQL then
 * produces the right numbers on four engines is the parity harness's job
 * (`parity/cases.ts`, the six `dsl:generic*` cases).
 *
 * The property this file exists for, above all others: **a grammar with a
 * `GROUP BY` in it is still a closed grammar.** Every dimension, every event
 * type and every scope predicate in the generic SQL comes from the registry;
 * every value comes from the caller and reaches SQL only as a bound parameter.
 * One hostile string is pushed through every field that takes one, and must
 * appear in `query_params` and nowhere else.
 */

import { describe, expect, it } from "vitest";
import { queryV1Schema } from "@uptimizr/schema";
import { allMetrics, getMetric, queryTier, type MetricDefinition } from "@uptimizr/metrics";
import { duckdbDialect } from "../query/duckdbDialect.js";
import { clickhouseDialect } from "../query/clickhouseDialect.js";
import { postgresDialect } from "../query/postgresDialect.js";
import { mssqlDialect } from "../query/mssqlDialect.js";
import type { Dialect } from "../query/dialect.js";
import { compileQuery, toBuilderOptions } from "../query/dsl/compile.js";
import { buildGenericGroupBy, genericResultColumns } from "../query/dsl/generic.js";
import { compareRows, comparisonKeys, summarizeComparison } from "../query/dsl/compare.js";
import { explainSpec, planWarnings, silentChannels, channelRows } from "../query/dsl/explain.js";
import { ORDER_AFTER_CAP_CAVEAT, applyOrder, reordersCappedResult } from "../query/dsl/order.js";

const PID = "p1";
const RANGE = { since: 1_757_000_000_000, until: 1_757_600_000_000 };
const DIALECTS: ReadonlyArray<readonly [string, Dialect]> = [
  ["duckdb", duckdbDialect],
  ["clickhouse", clickhouseDialect],
  ["postgres", postgresDialect],
  ["mssql", mssqlDialect],
];

function query(metric: string, extra: Record<string, unknown> = {}) {
  return queryV1Schema.parse({ v: 1, metric, range: RANGE, ...extra });
}

const GENERIC = allMetrics().filter((metric) => metric.genericGroupBy != null);

describe("the generic group-by compiler", () => {
  it("renders every generic metric at every dimension it declares, on every dialect", () => {
    for (const metric of GENERIC) {
      for (const dimension of metric.dimensions) {
        for (const [name, dialect] of DIALECTS) {
          const q = query(metric.id, { dimensions: [dimension] });
          if (queryTier(metric, q) !== "generic") continue;
          const spec = compileQuery(PID, q, dialect);
          expect(spec.metric, `${metric.id}/${dimension}/${name}`).toBe(metric.id);
          expect(spec.query, `${metric.id}/${dimension}/${name}`).toContain("GROUP BY");
          expect(spec.query).toContain("FROM events");
        }
      }
    }
  });

  it("projects exactly the registry's columns for the grain it was given", () => {
    const spec = compileQuery(
      PID,
      query("interaction_sources", { dimensions: ["scene", "source"] }),
      duckdbDialect,
    );
    const metric = getMetric("interaction_sources") as MetricDefinition;
    expect(genericResultColumns(metric, ["scene", "source"])).toEqual([
      "scene_id",
      "source",
      "count",
      "sessions",
    ]);
    expect(spec.query).toContain("events.scene_id AS scene_id");
    expect(spec.query).toContain("count(*) AS count");
    expect(spec.query).toContain("count(DISTINCT events.session_id) AS sessions");
  });

  it("keeps a metric's own column spelling when it regroups onto its own grain", () => {
    // `top_input_actions` calls the `name` dimension `action`; regrouping must
    // not silently rename a column the metric already returns.
    const metric = getMetric("top_input_actions") as MetricDefinition;
    expect(genericResultColumns(metric, ["name"])).toEqual(["action", "count"]);
    const spec = compileQuery(
      PID,
      query("top_input_actions", { dimensions: ["name", "scene"] }),
      duckdbDialect,
    );
    expect(spec.query).toContain("events.name AS action");
  });

  it("carries the metric's event scope and its scope predicate into the regrouped SQL", () => {
    const spec = compileQuery(PID, query("mesh_sources", { dimensions: ["scene"] }), duckdbDialect);
    expect(spec.query).toContain("events.event_type IN (");
    expect(spec.query).toContain("events.mesh != ''");
    // …and the event types are bound, not interpolated.
    expect(spec.query).not.toContain("mesh_interaction'");
    expect(Object.values(spec.query_params)).toContain("mesh_interaction");
  });

  it("joins the session-attribute CTE only when a session attribute is grouped by", () => {
    const grouped = compileQuery(
      PID,
      query("event_counts", { dimensions: ["device.os"] }),
      duckdbDialect,
    );
    expect(grouped.query).toContain("WITH session_attrs AS");
    expect(grouped.query).toContain("LEFT JOIN session_attrs");

    // A *filter* on a device attribute is a sub-select, not a join.
    const filtered = compileQuery(
      PID,
      query("event_counts", { dimensions: ["scene"], filters: { device: { os: "iOS" } } }),
      duckdbDialect,
    );
    expect(filtered.query).not.toContain("WITH session_attrs AS");
    expect(filtered.query).toContain("event_type = 'session_start'");
  });

  it("always bounds its own output, even for a metric with no row cap", () => {
    const spec = compileQuery(
      PID,
      query("event_counts", { dimensions: ["session"] }),
      duckdbDialect,
    );
    expect(spec.query).toContain("LIMIT");
    expect(spec.query_params.limit).toBe(200);
  });

  it("orders by the first measure descending unless told otherwise", () => {
    const fallback = compileQuery(
      PID,
      query("top_meshes", { dimensions: ["scene"] }),
      duckdbDialect,
    );
    expect(fallback.query).toContain("ORDER BY count DESC");
    const asked = compileQuery(
      PID,
      query("interaction_sources", {
        dimensions: ["scene"],
        order: { by: "sessions", dir: "asc" },
      }),
      duckdbDialect,
    );
    expect(asked.query).toContain("ORDER BY sessions ASC");
  });

  it("breaks ties on the grouping dimensions, so a LIMIT is deterministic", () => {
    const spec = compileQuery(
      PID,
      query("event_counts", { dimensions: ["event_type", "scene"] }),
      duckdbDialect,
    );
    expect(spec.query).toContain("ORDER BY count DESC, events.event_type ASC, events.scene_id ASC");
  });

  it("repeats the expressions in GROUP BY rather than naming output aliases", () => {
    // T-SQL rejects `GROUP BY <select alias>`; the mssql dialect rewrites it,
    // but not depending on the rewrite is cheaper than depending on it.
    const spec = compileQuery(
      PID,
      query("mesh_sources", { dimensions: ["scene", "source"] }),
      duckdbDialect,
    );
    expect(spec.query).toContain("GROUP BY events.scene_id, events.source");
  });

  it("lets every caller-supplied value reach SQL only as a bound parameter", () => {
    const hostile = "'; DROP TABLE events; --";
    const spec = compileQuery(
      PID,
      query("top_meshes", {
        dimensions: ["scene", "source"],
        segment: { scene: hostile, event_type: hostile },
        filters: {
          session: hostile,
          device: { os: hostile, browser: hostile },
          event: { type: "custom", name: hostile, mesh: hostile },
        },
      }),
      duckdbDialect,
    );
    expect(spec.query).not.toContain("DROP TABLE");
    expect(Object.values(spec.query_params)).toContain(hostile);
  });

  it("refuses to compile a metric that declares no generic tier", () => {
    const metric = getMetric("pointer_heatmap") as MetricDefinition;
    expect(() => buildGenericGroupBy(metric, PID, {}, duckdbDialect)).toThrow(
      /declares no genericGroupBy/,
    );
  });

  it("stays delegated when nothing needs the generic compiler", () => {
    const spec = compileQuery(PID, query("top_meshes"), duckdbDialect);
    // The delegated builder's SQL, byte for byte the canned endpoint's.
    expect(spec.query).toContain("SELECT mesh, count(*) AS count");
    expect(toBuilderOptions(query("top_meshes")).tier).toBeUndefined();
  });
});

describe("compare", () => {
  const metric = getMetric("top_meshes") as MetricDefinition;
  const context = {
    basis: "range" as const,
    keys: ["mesh"],
    currentRange: { since: 2, until: 3 },
    previousRange: { since: 1, until: 2 },
  };

  it("joins on the key, keeping arrivals and departures as rows", () => {
    const result = compareRows(
      metric,
      [
        { mesh: "box", count: 10 },
        { mesh: "floor", count: 5 },
      ],
      [
        { mesh: "box", count: 4 },
        { mesh: "sphere", count: 7 },
      ],
      context,
    );
    const rows = new Map((result?.rows ?? []).map((row) => [row.label, row]));
    expect(rows.get("box")).toMatchObject({ current: 10, previous: 4, delta: 6, deltaPct: 1.5 });
    expect(rows.get("floor")).toMatchObject({ current: 5, previous: null, delta: null });
    expect(rows.get("sphere")).toMatchObject({ current: null, previous: 7, delta: null });
  });

  it("ranks by the size of the move, not by the size of the row", () => {
    const result = compareRows(
      metric,
      [
        { mesh: "big", count: 1000 },
        { mesh: "small", count: 30 },
      ],
      [
        { mesh: "big", count: 999 },
        { mesh: "small", count: 5 },
      ],
      context,
    );
    expect(result?.rows[0]?.label).toBe("small");
  });

  it("reports a significance once both windows clear the metric's own minimum", () => {
    const result = compareRows(
      metric,
      [
        { mesh: "box", count: 40 },
        { mesh: "floor", count: 60 },
      ],
      [
        { mesh: "box", count: 20 },
        { mesh: "floor", count: 80 },
      ],
      context,
    );
    const box = result?.rows.find((row) => row.label === "box");
    expect(box?.significance?.test).toBe("two-proportion-z");
    expect(box?.significance?.significant).toBe(true);
  });

  it("omits the significance, and says why, below the minimum", () => {
    const result = compareRows(
      metric,
      [{ mesh: "box", count: 2 }],
      [{ mesh: "box", count: 1 }],
      context,
    );
    expect(result?.rows[0]?.significance).toBeUndefined();
    expect(result?.meta.caveats.join(" ")).toContain("minimum this metric declares");
  });

  it("omits the significance for a measure that is not a count", () => {
    const perf = getMetric("perf_by_scene") as MetricDefinition;
    const result = compareRows(
      perf,
      [{ scene_id: "lobby", p50_fps: 50, samples: 400 }],
      [{ scene_id: "lobby", p50_fps: 40, samples: 400 }],
      { ...context, keys: ["scene_id"] },
    );
    expect(result?.rows[0]?.delta).toBe(10);
    expect(result?.rows[0]?.significance).toBeUndefined();
    expect(result?.meta.caveats.join(" ")).toContain("not a count");
  });

  it("does not join a bucket metric on its axis, and tests its buckets with Welch", () => {
    const daily = getMetric("perf_daily") as MetricDefinition;
    expect(comparisonKeys(daily, ["day", "scene_id"])).not.toContain("day");
    const result = compareRows(
      daily,
      [
        { day: "2024-06-16", avg_fps: 60, sessions: 1, samples: 10 },
        { day: "2024-06-17", avg_fps: 58, sessions: 1, samples: 10 },
        { day: "2024-06-18", avg_fps: 61, sessions: 1, samples: 10 },
      ],
      [
        { day: "2024-06-09", avg_fps: 40, sessions: 1, samples: 10 },
        { day: "2024-06-10", avg_fps: 42, sessions: 1, samples: 10 },
        { day: "2024-06-11", avg_fps: 39, sessions: 1, samples: 10 },
      ],
      { ...context, keys: [] },
    );
    expect(result?.meta.overall?.test).toBe("welch-t");
    expect(result?.meta.overall?.significant).toBe(true);
    // The buckets collapse into one unkeyed row, averaged rather than summed.
    expect(result?.rows).toHaveLength(1);
    expect(result?.rows[0]?.current).toBeCloseTo(59.666_67, 4);
  });

  it("digests into movers with a templated reading", () => {
    const result = compareRows(
      metric,
      [
        { mesh: "box", count: 40 },
        { mesh: "floor", count: 60 },
      ],
      [
        { mesh: "box", count: 20 },
        { mesh: "floor", count: 80 },
      ],
      context,
    );
    const movers = summarizeComparison(metric, result!, { maxRows: 1 });
    expect(movers?.kind).toBe("movers");
    expect(movers?.top).toHaveLength(1);
    expect(movers?.rest.rows).toBe(1);
    expect(movers?.reading).toContain("Most-interacted meshes");
    expect(movers?.reading).toContain("Biggest mover");
    // The sentence is templated, so the same result always reads the same way.
    expect(summarizeComparison(metric, result!, { maxRows: 1 })?.reading).toBe(movers?.reading);
  });

  it("returns null for a metric the registry does not know", () => {
    expect(compareRows("not_a_metric" as never, [], [], context)).toBeNull();
  });
});

describe("explain", () => {
  it("lists parameters by name and type, and never by value", () => {
    const spec = compileQuery(
      PID,
      query("top_meshes", { filters: { session: "secret-session" } }),
      duckdbDialect,
    );
    const plan = explainSpec(spec);
    expect(plan.params.map((param) => param.name)).toEqual([
      "limit",
      "projectId",
      "session",
      "since",
      "until",
    ]);
    expect(plan.params.find((param) => param.name === "session")?.type).toBe("string");
    expect(plan.params.find((param) => param.name === "since")?.type).toBe("timestamp");
    expect(plan.params.find((param) => param.name === "limit")?.type).toBe("number");
    expect(JSON.stringify(plan)).not.toContain("secret-session");
  });

  it("names the silent capture channels and counts the ones that are not", () => {
    const metric = getMetric("top_meshes") as MetricDefinition;
    const counts = { pointer_click: 12, camera_sample: 30 };
    expect(silentChannels(metric, counts)).toEqual(["mesh_interaction"]);
    expect(channelRows(metric, counts)).toBe(42);
    // A metric with no declared channels cannot answer the question at all.
    expect(channelRows(getMetric("event_counts") as MetricDefinition, counts)).toBeNull();
  });

  it("warns about a disabled channel, a thin window, no proxy, and truncation", () => {
    const metric = getMetric("world_heatmap") as MetricDefinition;
    const warnings = planWarnings(
      metric,
      {
        tier: "delegated",
        dialect: "duckdb",
        channelCounts: {},
        limit: 10,
        rows: 10,
        spatial: { proxy: false, regions: 0 },
      },
      { sessions: null, events: 1 },
    );
    const text = warnings.join("\n");
    expect(text).toContain("capture channel switched off");
    expect(text).toContain("minimum at which a change is worth reporting");
    expect(text).toContain("no scene proxy");
    expect(text).toContain("row cap");
  });

  it("says nothing it cannot support", () => {
    const metric = getMetric("top_meshes") as MetricDefinition;
    expect(
      planWarnings(
        metric,
        { tier: "delegated", dialect: "duckdb" },
        { sessions: null, events: null },
      ),
    ).toEqual([]);
  });
});

describe("order on a delegated result", () => {
  const rows = [
    { mesh: "a", count: 3 },
    { mesh: "b", count: 1 },
    { mesh: "c", count: null },
    { mesh: "d", count: 2 },
  ];

  it("sorts by the column, in either direction", () => {
    expect(applyOrder(rows, { by: "count", dir: "asc" }).map((row) => row.mesh)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
    expect(applyOrder(rows, { by: "count", dir: "desc" }).map((row) => row.mesh)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("puts unmeasured rows last in both directions, never first", () => {
    for (const dir of ["asc", "desc"] as const) {
      expect(applyOrder(rows, { by: "count", dir }).at(-1)?.mesh).toBe("c");
    }
  });

  it("does not mutate the input", () => {
    const before = JSON.stringify(rows);
    applyOrder(rows, { by: "count", dir: "asc" });
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("flags the case where the cap had already chosen the rows", () => {
    expect(reordersCappedResult(rows, 4)).toBe(true);
    expect(reordersCappedResult(rows, 10)).toBe(false);
    expect(reordersCappedResult(rows, undefined)).toBe(false);
    expect(ORDER_AFTER_CAP_CAVEAT).toContain("smallest of the top rows");
  });
});
