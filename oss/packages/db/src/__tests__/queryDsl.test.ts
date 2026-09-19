/**
 * The delegated query compiler (ADR 0051 §3, design sketch §C.2, tier 1).
 *
 * The central claim of the delegated tier is that a DSL query is *the same
 * query* the canned endpoint runs — not a similar one. So the main gate below
 * compiles every registry aggregation through the DSL and asserts the resulting
 * `QuerySpec` is byte-identical to calling that metric's builder directly, on
 * **all four dialects**. If that holds, everything the parity harness already
 * proves about the builders holds for the DSL for free, and there is no second
 * SQL path to keep honest.
 *
 * The rest covers the mapping itself (registry `FILTER_TARGETS` → option
 * fields), the two values a query cannot carry on its own (a region id's bounds,
 * a derived `cellSize`), and the safety properties the grammar exists for: every
 * value is a bound parameter, and the spec carries its metric so the store edge
 * coerces the rows.
 */

import { describe, expect, it } from "vitest";
import { queryV1Schema, type QueryV1 } from "@uptimizr/schema";
import { allMetrics, getMetric, requiredFilters } from "@uptimizr/metrics";
import type { Dialect } from "../query/dialect.js";
import { duckdbDialect } from "../query/duckdbDialect.js";
import { clickhouseDialect } from "../query/clickhouseDialect.js";
import { postgresDialect } from "../query/postgresDialect.js";
import { mssqlDialect } from "../query/mssqlDialect.js";
import { builderFor, compileQuery, toBuilderOptions } from "../query/dsl/index.js";
import { PARITY_PROJECT_ID, PARITY_RANGE } from "../parity/fixtures.js";

const PID = PARITY_PROJECT_ID;

const DIALECTS: Readonly<Record<string, Dialect>> = {
  duckdb: duckdbDialect,
  clickhouse: clickhouseDialect,
  postgres: postgresDialect,
  mssql: mssqlDialect,
};

/** Values for the filters a metric cannot be queried without. */
const REQUIRED_VALUES: Readonly<Record<string, unknown>> = {
  session: "s1",
  scene: "lobby",
  mesh: "box",
  steps: [{ type: "session_start" }, { type: "mesh_interaction" }],
};

function query(metric: string, extra: Record<string, unknown> = {}): QueryV1 {
  return queryV1Schema.parse({ v: 1, metric, range: PARITY_RANGE, ...extra });
}

/** A query for `metricId` carrying whatever that metric declares as required. */
function callable(metricId: string): QueryV1 {
  const metric = getMetric(metricId)!;
  const filters: Record<string, unknown> = {};
  for (const id of requiredFilters(metric)) filters[id] = REQUIRED_VALUES[id];
  return query(metricId, Object.keys(filters).length > 0 ? { filters } : {});
}

// Everything the delegated compiler can reach: a metric with a `build*`. The
// two resource reads have none, and neither do the derived insight primitives
// (#305), which are computed over another metric's bucket series rather than by
// SQL of their own — `validateQuery` refuses both with `metric_not_queryable`.
const aggregations = allMetrics().filter((metric) => metric.builder !== undefined);

describe("the DSL compiles to exactly the canned aggregation", () => {
  it.each(aggregations.map((metric) => metric.id))(
    "%s renders the identical spec on every dialect",
    (id) => {
      const metric = getMetric(id)!;
      const q = callable(id);
      const options = toBuilderOptions(q);
      for (const [engine, dialect] of Object.entries(DIALECTS)) {
        const viaDsl = compileQuery(PID, q, dialect);
        const direct = builderFor(metric.builder!)(PID, { ...options }, dialect);
        expect(viaDsl, `${id} on ${engine}`).toEqual(direct);
      }
    },
  );

  it("tags every compiled spec with its metric, so the store edge coerces its rows", () => {
    for (const metric of aggregations) {
      expect(compileQuery(PID, callable(metric.id), duckdbDialect).metric, metric.id).toBe(
        metric.id,
      );
    }
  });

  it("binds every value as a parameter — nothing the caller sends is interpolated", () => {
    const spec = compileQuery(
      PID,
      // A mesh name is free text (a scene id is not), so it is the widest
      // string the grammar accepts and the right place to prove the point.
      query("mesh_uv_heatmap", { filters: { mesh: "box'; DROP TABLE events; --" } }),
      duckdbDialect,
    );
    expect(spec.query).not.toContain("DROP TABLE");
    expect(Object.values(spec.query_params)).toContain("box'; DROP TABLE events; --");
  });
});

describe("toBuilderOptions maps filters through the registry", () => {
  it("carries the required range as the builder's since/until", () => {
    expect(toBuilderOptions(query("top_meshes"))).toEqual({
      since: PARITY_RANGE.since,
      until: PARITY_RANGE.until,
    });
  });

  it("translates the camera-mode toggle to the stored cameraType (ADR 0026)", () => {
    expect(
      toBuilderOptions(query("mesh_sources", { filters: { cameraMode: "first-person" } })),
    ).toMatchObject({ cameraType: "free" });
    expect(
      toBuilderOptions(query("mesh_sources", { filters: { cameraMode: "viewer" } })),
    ).toMatchObject({ cameraType: "arc-rotate" });
  });

  it("lifts the top-level row cap onto the builder's limit option", () => {
    expect(toBuilderOptions(query("top_meshes", { limit: 5 }))).toMatchObject({ limit: 5 });
  });

  it("assembles the indexed center[] option the distance metric takes", () => {
    const options = toBuilderOptions(
      query("camera_distance", { filters: { centerX: 1, centerY: 2, centerZ: 3 } }),
    );
    expect(options.center).toEqual([1, 2, 3]);
  });

  it("passes an explicit region box straight through", () => {
    const options = toBuilderOptions(
      query("world_heatmap", { filters: { region: [0, 0, 0, 1, 1, 1] } }),
    );
    expect(options.region).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("refuses to compile a region id the caller has not resolved to bounds", () => {
    const q = query("world_heatmap", { filters: { scene: "lobby", region: "entrance" } });
    expect(() => toBuilderOptions(q)).toThrow(/must be resolved to bounds/);
    expect(toBuilderOptions(q, { region: [0, 0, 0, 2, 2, 2] })).toMatchObject({
      region: [0, 0, 0, 2, 2, 2],
    });
  });

  it("takes a derived cellSize only when the caller did not pin one", () => {
    expect(toBuilderOptions(query("world_heatmap"), { cellSize: 4 })).toMatchObject({
      cellSize: 4,
    });
    expect(
      toBuilderOptions(query("world_heatmap", { filters: { cellSize: 1 } }), { cellSize: 4 }),
    ).toMatchObject({ cellSize: 1 });
  });

  it("drops the grammar keys v1 does not execute rather than mis-mapping them", () => {
    // `validateQuery` rejects these before compilation; this keeps the mapper
    // total if a caller skips that step.
    const q = query("top_meshes", {
      filters: { event: { type: "mesh_interaction" }, device: { os: "iOS" } },
    });
    expect(toBuilderOptions(q)).toEqual({
      since: PARITY_RANGE.since,
      until: PARITY_RANGE.until,
    });
  });
});

describe("compileQuery guards", () => {
  it("refuses a metric with no aggregation builder", () => {
    expect(() => compileQuery(PID, query("session_meta"), duckdbDialect)).toThrow(
      /no aggregation builder/,
    );
  });

  it("refuses a builder name the aggregations module does not export", () => {
    expect(() => builderFor("buildNothing" as never)).toThrow(/no aggregation builder/);
  });
});
