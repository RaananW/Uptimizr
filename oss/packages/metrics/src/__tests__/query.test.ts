/**
 * Registry gates for the query DSL (ADR 0051 §3).
 *
 * Three things are checked here, all pure:
 *
 * 1. **Reachability** — every registry metric with a builder can be expressed as
 *    a query that validates. This is acceptance criterion 1 of #303: the DSL is
 *    not a subset of the canned surface.
 * 2. **The 400s** — an unknown metric, a dimension the metric is not keyed by, a
 *    filter it does not accept, a missing required filter and an over-cap limit
 *    each produce their own code, and the message names what *would* work.
 * 3. **Drift** — the schema's filter vocabulary and the registry's `FilterId`
 *    union stay in step, so a new filter cannot reach a canned endpoint without
 *    also reaching the DSL.
 */

import { describe, expect, it } from "vitest";
import { queryFiltersSchema, queryV1Schema, type QueryV1 } from "@uptimizr/schema";
import { FILTER_TARGETS, allMetrics, getMetric, isResourceMetric } from "../registry.js";
import type { FilterId } from "../registry.js";
import { nativeDimensions, queryableFilters, requiredFilters, validateQuery } from "../query.js";

const RANGE = { since: 1_757_000_000_000, until: 1_757_600_000_000 };

/** A minimal, structurally-valid query for `metric`. */
function query(metric: string, extra: Record<string, unknown> = {}): QueryV1 {
  return queryV1Schema.parse({ v: 1, metric, range: RANGE, ...extra });
}

/** Placeholder values for the filters a metric cannot be queried without. */
const REQUIRED_VALUES: Readonly<Record<string, unknown>> = {
  session: "s1",
  scene: "lobby",
  mesh: "box",
  steps: [{ type: "session_start" }, { type: "mesh_interaction" }],
};

/** A query that supplies whatever the metric declares as required. */
function callable(metricId: string): QueryV1 {
  const metric = getMetric(metricId)!;
  const filters: Record<string, unknown> = {};
  for (const id of requiredFilters(metric)) filters[id] = REQUIRED_VALUES[id];
  return query(metricId, Object.keys(filters).length > 0 ? { filters } : {});
}

const aggregations = allMetrics().filter((metric) => !isResourceMetric(metric));

describe("every metric is reachable through the DSL", () => {
  it.each(aggregations.map((metric) => metric.id))("%s validates", (id) => {
    expect(validateQuery(callable(id)).issues).toEqual([]);
  });

  it("covers the whole aggregation surface, not a subset of it", () => {
    // Guards against the list above silently shrinking: if the registry grows an
    // aggregation, this suite must grow with it.
    expect(aggregations.length).toBe(allMetrics().length - 2);
  });

  it("accepts each metric's own grain as explicit dimensions", () => {
    for (const metric of aggregations) {
      const dimensions = nativeDimensions(metric);
      if (dimensions.length === 0 || dimensions.length > 3) continue;
      const q = callable(metric.id);
      const issues = validateQuery({ ...q, dimensions: [...dimensions] }).issues;
      expect(issues, metric.id).toEqual([]);
    }
  });
});

describe("nativeDimensions", () => {
  it("is the grain the rows actually carry, not everything the metric can be filtered by", () => {
    // `top_meshes` declares `mesh` and `session` but returns `{ mesh, count }`:
    // it can be scoped to a session, never broken down by one.
    expect(getMetric("top_meshes")!.dimensions).toContain("session");
    expect(nativeDimensions(getMetric("top_meshes")!)).toEqual(["mesh"]);
    expect(nativeDimensions(getMetric("mesh_sources")!)).toEqual(["mesh", "source"]);
  });

  it("is always a subset of the declared dimensions", () => {
    for (const metric of allMetrics()) {
      for (const dimension of nativeDimensions(metric)) {
        expect(metric.dimensions, metric.id).toContain(dimension);
      }
    }
  });
});

describe("validateQuery rejects", () => {
  it("an unknown metric, pointing at where the vocabulary lives", () => {
    const [issue] = validateQuery(query("not_a_metric")).issues;
    expect(issue?.code).toBe("unknown_metric");
    expect(issue?.message).toContain("uptimizr://capabilities");
  });

  it("a resource read, which is a stored record rather than an aggregation", () => {
    const [issue] = validateQuery(query("session_meta")).issues;
    expect(issue?.code).toBe("metric_not_queryable");
  });

  it("a dimension the metric does not declare at all", () => {
    const [issue] = validateQuery(query("top_meshes", { dimensions: ["event_type"] })).issues;
    expect(issue?.code).toBe("unknown_dimension");
    expect(issue?.accepted).toContain("mesh");
  });

  it("a dimension the metric can only be filtered by", () => {
    const [issue] = validateQuery(query("top_meshes", { dimensions: ["session"] })).issues;
    expect(issue?.code).toBe("dimension_not_native");
    expect(issue?.message).toContain("Pass it as a filter instead");
    expect(issue?.accepted).toEqual(["mesh"]);
  });

  it("a partial grain, because a builder renders one fixed grain", () => {
    const [issue] = validateQuery(query("mesh_sources", { dimensions: ["mesh"] })).issues;
    expect(issue?.code).toBe("dimension_not_native");
    expect(issue?.accepted).toEqual(["mesh", "source"]);
  });

  it("a filter the metric does not accept, naming the ones it does", () => {
    const [issue] = validateQuery(query("top_meshes", { filters: { scene: "lobby" } })).issues;
    expect(issue?.code).toBe("unsupported_filter");
    expect(issue?.path).toBe("filters.scene");
    expect(issue?.accepted).toContain("session");
  });

  it("a missing filter the metric cannot be queried without", () => {
    const issues = validateQuery(query("funnel")).issues;
    expect(issues.map((i) => i.code)).toContain("missing_filter");
    expect(validateQuery(query("session_trajectory")).issues[0]?.path).toBe("filters.session");
  });

  it("a limit above the metric's registry cap, and one on a metric that takes none", () => {
    // `fps_histogram` caps at 100 rows, well under the grammar's own 1000, so
    // the registry cap is what bites — which is the point of having both.
    const cap = getMetric("fps_histogram")!.limits.maxRows;
    expect(validateQuery(query("fps_histogram", { limit: cap })).issues).toEqual([]);
    const [issue] = validateQuery(query("fps_histogram", { limit: cap + 1 })).issues;
    expect(issue?.code).toBe("limit_too_large");
    expect(issue?.message).toContain(String(cap));
    // `event_counts` returns one row per event type and its builder takes no
    // row cap; accepting `limit` and ignoring it would be a lie.
    expect(validateQuery(query("event_counts", { limit: 10 })).issues[0]?.code).toBe(
      "unsupported_filter",
    );
  });

  it("the grammar v1 parses but does not answer, saying so explicitly", () => {
    const deferred: Record<string, unknown>[] = [
      { compare: { range: { since: 1, until: 2 } } },
      { segment: { mesh: "box" } },
      { order: { by: "count", dir: "desc" } },
      { explain: true },
      { filters: { event: { type: "mesh_interaction" } } },
      { filters: { device: { os: "iOS" } } },
    ];
    for (const extra of deferred) {
      const issues = validateQuery(query("top_meshes", extra)).issues;
      expect(
        issues.map((i) => i.code),
        JSON.stringify(extra),
      ).toContain("unsupported_feature");
      expect(issues[0]?.message).toContain("not supported yet");
    }
  });

  it("everything that is wrong at once, so one round trip is enough", () => {
    const issues = validateQuery(
      query("top_meshes", { dimensions: ["session"], filters: { scene: "lobby" }, limit: 1000 }),
    ).issues;
    expect(issues.map((i) => i.code).sort()).toEqual([
      "dimension_not_native",
      "unsupported_filter",
    ]);
  });
});

describe("the filter vocabulary cannot drift from the registry", () => {
  /**
   * Filter ids that are not DSL `filters` keys: the window is `range`, the
   * envelope is `format`, and the row cap is `limit` — all top-level fields.
   */
  const NOT_FILTERS: readonly FilterId[] = ["since", "until", "format", "limit"];
  /** DSL-only grammar keys with no `FilterId` (deferred to #304). */
  const GRAMMAR_ONLY = ["event", "device"];

  it("declares exactly the registry's filter ids, minus range and format", () => {
    const schemaKeys = Object.keys(queryFiltersSchema.shape)
      .filter((key) => !GRAMMAR_ONLY.includes(key))
      .sort();
    const registryKeys = (Object.keys(FILTER_TARGETS) as FilterId[])
      .filter((id) => !NOT_FILTERS.includes(id))
      .sort();
    expect(schemaKeys).toEqual(registryKeys);
  });

  it("offers every metric's filters, so a DSL query is never weaker than its endpoint", () => {
    const schemaKeys = new Set(Object.keys(queryFiltersSchema.shape));
    for (const metric of aggregations) {
      for (const filter of queryableFilters(metric)) {
        if (filter === "limit") continue; // top-level, not a `filters` key
        expect(schemaKeys, `${metric.id}.${filter}`).toContain(filter);
      }
    }
  });
});
