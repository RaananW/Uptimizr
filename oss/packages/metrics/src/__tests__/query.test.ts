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
import {
  FILTER_TARGETS,
  allMetrics,
  getMetric,
  isResourceMetric,
  metricCapability,
} from "../registry.js";
import type { FilterId } from "../registry.js";
import {
  genericDimensions,
  nativeDimensions,
  orderableColumns,
  queryTier,
  queryableFilters,
  requiredFilters,
  segmentableDimensions,
  validateQuery,
} from "../query.js";

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

// The DSL answers the ordinary `query` surface. Two registry entries are
// resource reads rather than aggregations, and `session_narrative` (#314) is a
// `query:raw` compaction of one session — `POST /api/v1/query` carries the
// ordinary `query` capability, so it is deliberately not reachable there.
const aggregations = allMetrics().filter(
  (metric) => !isResourceMetric(metric) && metricCapability(metric) === "query",
);

describe("every metric is reachable through the DSL", () => {
  it.each(aggregations.map((metric) => metric.id))("%s validates", (id) => {
    expect(validateQuery(callable(id)).issues).toEqual([]);
  });

  it("covers the whole aggregation surface, not a subset of it", () => {
    // Guards against the list above silently shrinking: if the registry grows an
    // aggregation, this suite must grow with it. Exactly three entries are
    // outside the DSL — the two resource reads and `session_narrative`.
    expect(allMetrics().length - aggregations.length).toBe(3);
    expect(
      allMetrics()
        .filter((metric) => !aggregations.includes(metric))
        .map((metric) => metric.id)
        .sort(),
    ).toEqual(["scene_representation", "session_meta", "session_narrative"]);
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
    const [issue] = validateQuery(query("top_meshes", { dimensions: ["device.isMobile"] })).issues;
    expect(issue?.code).toBe("unknown_dimension");
    expect(issue?.accepted).toContain("mesh");
  });

  it("a dimension a delegated metric can only be filtered by", () => {
    // `pointer_heatmap` bins screen coordinates; its measure *is* that binning,
    // so there is no other grain to move it to and no generic tier to move it
    // with.
    const [issue] = validateQuery(query("pointer_heatmap", { dimensions: ["session"] })).issues;
    expect(issue?.code).toBe("dimension_not_native");
    expect(issue?.message).toContain("Pass it as a filter instead");
  });

  it("a partial grain on a metric with no generic tier", () => {
    const [issue] = validateQuery(query("perf_by_device", { dimensions: ["device.os"] })).issues;
    expect(issue?.code).toBe("dimension_not_native");
    expect(issue?.accepted).toEqual([...nativeDimensions(getMetric("perf_by_device")!)]);
  });

  it("the same dimension twice", () => {
    const [issue] = validateQuery(query("top_meshes", { dimensions: ["mesh", "mesh"] })).issues;
    expect(issue?.code).toBe("unknown_dimension");
    expect(issue?.message).toContain("twice");
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

  it("an event or device predicate on a metric with no generic tier", () => {
    for (const filters of [{ event: { type: "mesh_interaction" } }, { device: { os: "iOS" } }]) {
      const issues = validateQuery(query("pointer_heatmap", { filters })).issues;
      expect(
        issues.map((i) => i.code),
        JSON.stringify(filters),
      ).toContain("unsupported_feature");
      expect(issues[0]?.message).toContain("generic group-by tier");
    }
  });

  it("an order on a label column, and on a result whose order is not a choice", () => {
    const [byLabel] = validateQuery(
      query("top_meshes", { order: { by: "mesh", dir: "asc" } }),
    ).issues;
    expect(byLabel?.code).toBe("unsupported_order");
    expect(byLabel?.accepted).toContain("count");

    // A histogram walks its bins; "order it by count" is not a question about it.
    const [onSeries] = validateQuery(
      query("fps_histogram", { order: { by: "count", dir: "asc" } }),
    ).issues;
    expect(onSeries?.code).toBe("unsupported_order");
    expect(onSeries?.accepted).toEqual([]);
  });

  it("a segment on a dimension the metric can neither filter nor group by", () => {
    // `perf_by_device` is keyed by five device attributes but can only be
    // filtered by scene and session, and has no generic tier to hold one fixed.
    const [issue] = validateQuery(
      query("perf_by_device", { segment: { "device.os": "iOS" } }),
    ).issues;
    expect(issue?.code).toBe("unsupported_segment");
    expect(issue?.accepted).toEqual([...segmentableDimensions(getMetric("perf_by_device")!)]);
  });

  it("a comparison segment, on the same terms as the query's own", () => {
    const [issue] = validateQuery(
      query("perf_by_device", { compare: { segment: { "device.os": "iOS" } } }),
    ).issues;
    expect(issue?.code).toBe("unsupported_segment");
    expect(issue?.path).toBe("compare.segment.device.os");
  });

  it("everything that is wrong at once, so one round trip is enough", () => {
    const issues = validateQuery(
      query("top_meshes", {
        dimensions: ["device.isMobile"],
        filters: { scene: "lobby" },
        order: { by: "mesh", dir: "asc" },
      }),
    ).issues;
    expect(issues.map((i) => i.code).sort()).toEqual([
      "unknown_dimension",
      "unsupported_filter",
      "unsupported_order",
    ]);
  });
});

describe("the generic group-by tier", () => {
  const generic = aggregations.filter((metric) => metric.genericGroupBy != null);

  it("covers the count-shaped metrics, and only those", () => {
    expect(generic.map((metric) => metric.id).sort()).toEqual([
      "camera_gestures",
      "event_counts",
      "interaction_sources",
      "mesh_interaction_kinds",
      "mesh_sources",
      "top_input_actions",
      "top_meshes",
    ]);
  });

  it("accepts any renderable subset of a generic metric's declared dimensions", () => {
    for (const metric of generic) {
      for (const dimension of genericDimensions(metric)) {
        const issues = validateQuery(query(metric.id, { dimensions: [dimension] })).issues;
        expect(issues, `${metric.id} by ${dimension}`).toEqual([]);
      }
    }
  });

  it("stays on the delegated tier until something actually needs the generic one", () => {
    const meshes = getMetric("top_meshes")!;
    expect(queryTier(meshes, query("top_meshes"))).toBe("delegated");
    expect(queryTier(meshes, query("top_meshes", { dimensions: ["mesh"] }))).toBe("delegated");
    expect(queryTier(meshes, query("top_meshes", { filters: { session: "s1" } }))).toBe(
      "delegated",
    );
    // `session` is one of `top_meshes`' own filters, so holding it fixed needs
    // nothing its builder cannot already do.
    expect(queryTier(meshes, query("top_meshes", { segment: { session: "s1" } }))).toBe(
      "delegated",
    );
    expect(queryTier(meshes, query("top_meshes", { dimensions: ["source"] }))).toBe("generic");
    expect(queryTier(meshes, query("top_meshes", { filters: { device: { os: "iOS" } } }))).toBe(
      "generic",
    );
    expect(queryTier(meshes, query("top_meshes", { segment: { scene: "lobby" } }))).toBe("generic");
  });

  it("orders by a generic measure column", () => {
    const sources = getMetric("interaction_sources")!;
    expect(orderableColumns(sources, "generic")).toEqual(["count", "sessions"]);
    expect(
      validateQuery(
        query("interaction_sources", {
          dimensions: ["scene"],
          order: { by: "sessions", dir: "asc" },
        }),
      ).issues,
    ).toEqual([]);
  });

  it("refuses a device attribute nothing captures, rather than matching nothing", () => {
    const [issue] = validateQuery(
      query("event_counts", { dimensions: ["scene"], filters: { device: { gpuTier: "high" } } }),
    ).issues;
    expect(issue?.code).toBe("unsupported_filter");
    expect(issue?.path).toBe("filters.device.gpuTier");
    expect(issue?.accepted).toEqual(["os", "browser"]);
    // …while the two that are captured pass.
    expect(
      validateQuery(
        query("event_counts", { dimensions: ["scene"], filters: { device: { os: "iOS" } } }),
      ).issues,
    ).toEqual([]);
  });

  it("takes a limit even where the canned endpoint has no row cap", () => {
    // `event_counts` declares no `limit` filter, but the generic tier always
    // bounds its own output — a group-by on `session` is unbounded without one.
    expect(validateQuery(query("event_counts", { limit: 10 })).issues[0]?.code).toBe(
      "unsupported_filter",
    );
    expect(
      validateQuery(query("event_counts", { dimensions: ["session"], limit: 10 })).issues,
    ).toEqual([]);
  });
});

describe("the filter vocabulary cannot drift from the registry", () => {
  /**
   * Filter ids that are not DSL `filters` keys: the window is `range`, the
   * envelope is `format`, and the row cap is `limit` — all top-level fields.
   */
  const NOT_FILTERS: readonly FilterId[] = ["since", "until", "format", "limit"];
  /**
   * Filter ids whose only metric is outside the DSL: `session_narrative`'s
   * compaction bounds (#314). A `query:raw` read is not reachable through
   * `POST /api/v1/query`, so the grammar has no key for them.
   */
  const NOT_IN_DSL: readonly FilterId[] = ["minDwellMs", "maxEntries"];
  /** DSL-only grammar keys with no `FilterId` (deferred to #304). */
  const GRAMMAR_ONLY = ["event", "device"];

  it("declares exactly the registry's filter ids, minus range and format", () => {
    const schemaKeys = Object.keys(queryFiltersSchema.shape)
      .filter((key) => !GRAMMAR_ONLY.includes(key))
      .sort();
    const registryKeys = (Object.keys(FILTER_TARGETS) as FilterId[])
      .filter((id) => !NOT_FILTERS.includes(id) && !NOT_IN_DSL.includes(id))
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
