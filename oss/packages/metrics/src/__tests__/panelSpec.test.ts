/**
 * Registry gates for declarative panel specs (ADR 0051 §7, sketch §G.3).
 *
 * Three things are pinned here:
 *
 * 1. **The chart/grain matrix**, exhaustively — every chart against every
 *    grain, read off the real registry rather than a fixture, so a metric added
 *    with a new grain cannot quietly become undrawable.
 * 2. **That `suggestChart` never proposes a spec the validator would refuse.**
 *    The assistant's "Pin as panel" is only trustworthy if that holds for every
 *    metric in the registry, so it is asserted for every metric in the registry.
 * 3. **That the published compatibility table is this table.** `PANEL_CHART_RULES`
 *    is what the docs render and what the validator enforces; if those could
 *    drift, the docs would be the more convincing of the two and also wrong.
 */

import { describe, expect, it } from "vitest";
import type { PanelChartKind, PanelSpecV1, QueryV1 } from "@uptimizr/schema";
import {
  PANEL_CHART_RULES,
  axisColumn,
  chartSuitsMetric,
  chartsForMetric,
  defaultEncoding,
  labelColumn,
  measureColumn,
  resultColumns,
  suggestChart,
  validatePanelSpec,
} from "../panelSpec.js";
import { allMetrics, getMetric, isAggregateMetric, type MetricId } from "../registry.js";

const CHARTS: readonly PanelChartKind[] = [
  "stat",
  "table",
  "bar",
  "line",
  "area",
  "heatmap2d",
  "world3d",
];

/** Every metric a panel spec could legitimately name (the DSL can compile it). */
function queryableMetrics() {
  return allMetrics().filter((metric) => isAggregateMetric(metric));
}

function metric(id: MetricId) {
  const found = getMetric(id);
  if (!found) throw new Error(`no such metric: ${id}`);
  return found;
}

/** A spec over `id`, with everything but the interesting part defaulted. */
function spec(
  id: MetricId,
  chart: PanelChartKind,
  extra: Partial<PanelSpecV1> = {},
  query: Partial<PanelSpecV1["query"]> = {},
): PanelSpecV1 {
  return {
    v: 1,
    title: "A pinned answer",
    chart,
    span: 1,
    ...extra,
    query: { v: 1, metric: id, range: "inherit", ...query } as PanelSpecV1["query"],
  };
}

function codes(result: { issues: readonly { code: string }[] }): string[] {
  return result.issues.map((issue) => issue.code);
}

describe("the chart/grain compatibility matrix", () => {
  // One representative metric per grain, chosen because each is the metric a
  // person would actually pin from that grain.
  const REPRESENTATIVE: Record<string, MetricId> = {
    project: "perf_summary",
    mesh: "top_meshes",
    scene: "list_scenes",
    session: "list_sessions",
    row: "event_counts",
    bucket: "timeseries",
    bin: "pointer_heatmap",
    voxel: "world_heatmap",
  };

  // The whole matrix, written out. A change to a rule has to be made here too,
  // which is the point: the table is a promise, not an implementation detail.
  const EXPECTED: Record<string, readonly PanelChartKind[]> = {
    project: ["table", "stat"],
    mesh: ["table", "bar"],
    scene: ["table", "bar"],
    session: ["table", "bar"],
    row: ["table", "bar"],
    bucket: ["table", "bar", "line", "area"],
    bin: ["table", "heatmap2d"],
    voxel: ["table", "world3d"],
  };

  for (const [grain, id] of Object.entries(REPRESENTATIVE)) {
    it(`draws a ${grain}-grain metric (${id}) as ${EXPECTED[grain]!.join(", ")} and nothing else`, () => {
      const definition = metric(id);
      expect(definition.grain).toBe(grain);
      expect([...chartsForMetric(definition)].sort()).toEqual([...EXPECTED[grain]!].sort());
      for (const chart of CHARTS) {
        expect(chartSuitsMetric(chart, definition), `${id} as ${chart}`).toBe(
          EXPECTED[grain]!.includes(chart),
        );
      }
    });
  }

  it("refuses a line over a ranking — there is no axis to walk along", () => {
    const result = validatePanelSpec(spec("top_meshes", "line"));
    expect(codes(result)).toEqual(["chart_grain_mismatch"]);
    expect(result.issues[0]!.path).toBe("chart");
    expect(result.issues[0]!.accepted).toContain("bar");
    expect(result.issues[0]!.message).toMatch(/ordered axis/);
  });

  it("refuses a heatmap over anything that is not already binned", () => {
    expect(codes(validatePanelSpec(spec("timeseries", "heatmap2d")))).toEqual([
      "chart_grain_mismatch",
    ]);
    expect(codes(validatePanelSpec(spec("world_heatmap", "heatmap2d")))).toEqual([
      "chart_grain_mismatch",
    ]);
    expect(codes(validatePanelSpec(spec("pointer_heatmap", "heatmap2d")))).toEqual([]);
  });

  it("refuses a 3D view over anything that is not voxelised", () => {
    expect(codes(validatePanelSpec(spec("pointer_heatmap", "world3d")))).toEqual([
      "chart_grain_mismatch",
    ]);
    expect(codes(validatePanelSpec(spec("world_heatmap", "world3d")))).toEqual([]);
  });

  it("refuses a stat over a list — it would show the first row and hide the rest", () => {
    expect(codes(validatePanelSpec(spec("top_meshes", "stat")))).toEqual(["chart_grain_mismatch"]);
    expect(codes(validatePanelSpec(spec("perf_summary", "stat")))).toEqual([]);
  });

  it("lets every queryable metric be drawn as a table — nothing is unpinnable", () => {
    for (const definition of queryableMetrics()) {
      expect(chartSuitsMetric("table", definition), definition.id).toBe(true);
    }
  });

  it("publishes exactly the rules it enforces", () => {
    expect(PANEL_CHART_RULES.map((rule) => rule.chart).sort()).toEqual([...CHARTS].sort());
    for (const rule of PANEL_CHART_RULES) {
      expect(rule.requires.length, rule.chart).toBeGreaterThan(0);
      // Every rule must actually discriminate: a rule nothing fails is a rule
      // that is not doing anything, except `table`, which accepts on purpose.
      const accepted = queryableMetrics().filter((m) => rule.accepts(m)).length;
      if (rule.chart === "table") expect(accepted).toBe(queryableMetrics().length);
      else expect(accepted, rule.chart).toBeLessThan(queryableMetrics().length);
    }
  });

  it("pins the wording the docs publish, so the table and the validator cannot drift", () => {
    // This table is written out by hand in three places a reader trusts:
    // `docs/integration.md`, the docs site's `guides/custom-panels.md`, and
    // `api/query.mdx`. A published table that no longer describes the code is
    // worse than no table, because it is the more convincing of the two — so
    // changing a rule has to fail here first.
    expect(
      Object.fromEntries(PANEL_CHART_RULES.map((rule) => [rule.chart, rule.requires])),
    ).toEqual({
      table: "nothing — any metric's rows can be listed",
      stat: "a single-record result (a `project`-grain metric with no grain dimensions)",
      bar:
        "a label column, a measure column, and a ranked or bucketed grain " +
        "(`mesh`, `scene`, `session`, `row`, `bucket`)",
      line: "an ordered axis column — in practice a `bucket`-grain metric",
      area: "an ordered axis column — in practice a `bucket`-grain metric",
      heatmap2d: "a `bin` grain (the metric already bins its input into a grid)",
      world3d: "a `voxel` grain (the metric already bins its input into world-space cells)",
    });
  });
});

describe("validatePanelSpec", () => {
  it("accepts a well-formed spec and reports the metric and tier", () => {
    const result = validatePanelSpec(
      spec(
        "top_meshes",
        "bar",
        { encoding: { x: "mesh", y: "count" }, note: "The crate wins by three to one." },
        { limit: 10 },
      ),
    );
    expect(result.issues).toEqual([]);
    expect(result.metric?.id).toBe("top_meshes");
    expect(result.tier).toBe("delegated");
  });

  it("runs the DSL's own validation over the query, and paths the issues into it", () => {
    const unknown = validatePanelSpec(spec("no_such_metric" as MetricId, "table"));
    expect(codes(unknown)).toEqual(["unknown_metric"]);
    expect(unknown.issues[0]!.path).toBe("query.metric");

    const badFilter = validatePanelSpec(
      spec("top_meshes", "bar", {}, { filters: { cellSize: 0.5 } } as never),
    );
    expect(codes(badFilter)).toContain("unsupported_filter");
    expect(badFilter.issues[0]!.path).toBe("query.filters.cellSize");
  });

  it("stops at the query when the metric does not resolve — nothing else is answerable", () => {
    const result = validatePanelSpec(spec("session_meta", "world3d", { encoding: { x: "nope" } }));
    expect(codes(result)).toEqual(["metric_not_queryable"]);
    expect(result.metric).toBeUndefined();
  });

  it("rejects an encoding column the metric's result does not carry", () => {
    const result = validatePanelSpec(
      spec("top_meshes", "bar", { encoding: { x: "mesh", y: "hits" } }),
    );
    expect(codes(result)).toEqual(["unknown_encoding_column"]);
    expect(result.issues[0]!.path).toBe("encoding.y");
    expect(result.issues[0]!.accepted).toContain("count");
  });

  it("checks the encoding against the columns a *regrouped* query really returns", () => {
    // `top_meshes` grouped by `source` runs on the generic tier and projects
    // `source` + the generic measures — the metric's own `mesh` column is gone.
    const query = { dimensions: ["source"] } as Partial<PanelSpecV1["query"]>;
    const columns = resultColumns(metric("top_meshes"), {
      v: 1,
      metric: "top_meshes",
      dimensions: ["source"],
      range: { since: 0, until: 1 },
      format: "full",
      explain: false,
    } as QueryV1);
    expect(columns).toContain("source");
    expect(columns).not.toContain("mesh");

    const regrouped = validatePanelSpec(
      spec("top_meshes", "bar", { encoding: { x: "mesh", y: "count" } }, query),
    );
    expect(codes(regrouped)).toEqual(["unknown_encoding_column"]);
    expect(regrouped.issues[0]!.message).toMatch(/when grouped this way/);

    expect(
      codes(validatePanelSpec(spec("top_meshes", "bar", { encoding: { x: "source" } }, query))),
    ).toEqual([]);
  });

  it("collects the chart and the encoding objection together, in one round trip", () => {
    const result = validatePanelSpec(
      spec("top_meshes", "line", { encoding: { x: "mesh", y: "hits" } }),
    );
    expect(codes(result).sort()).toEqual(["chart_grain_mismatch", "unknown_encoding_column"]);
  });

  it("does not care which window `inherit` becomes", () => {
    const inherited = validatePanelSpec(spec("timeseries", "line"));
    const pinned = validatePanelSpec(
      spec("timeseries", "line", {}, { range: { since: 1_000, until: 2_000 } }),
    );
    expect(inherited.issues).toEqual(pinned.issues);
  });
});

describe("suggestChart", () => {
  it("picks the drawing each grain already is", () => {
    const at = (id: MetricId) =>
      suggestChart(metric(id), {
        v: 1,
        metric: id,
        range: { since: 0, until: 1 },
        format: "full",
        explain: false,
      } as QueryV1);
    expect(at("world_heatmap")).toBe("world3d");
    expect(at("pointer_heatmap")).toBe("heatmap2d");
    expect(at("perf_summary")).toBe("stat");
    expect(at("timeseries")).toBe("line");
    expect(at("top_meshes")).toBe("bar");
    expect(at("aggregate_paths")).toBe("table");
  });

  it("never proposes a chart the validator would refuse — for any metric", () => {
    for (const definition of queryableMetrics()) {
      const query = {
        v: 1,
        metric: definition.id,
        range: { since: 0, until: 1 },
        format: "full",
        explain: false,
      } as QueryV1;
      const chart = suggestChart(definition, query);
      expect(chartSuitsMetric(chart, definition), `${definition.id} → ${chart}`).toBe(true);
    }
  });

  it("falls back to a table for an id the registry does not know", () => {
    expect(
      suggestChart(
        "no_such_metric" as MetricId,
        {
          v: 1,
          metric: "no_such_metric",
          range: { since: 0, until: 1 },
          format: "full",
          explain: false,
        } as QueryV1,
      ),
    ).toBe("table");
  });
});

describe("defaultEncoding", () => {
  it("puts the label on x and the measure on y for a ranking", () => {
    expect(defaultEncoding(metric("top_meshes"), "bar")).toEqual({ x: "mesh", y: "count" });
  });

  it("prefers the ordered axis over the label for a line", () => {
    // `mesh_trend` labels its rows by `mesh` but advances along `bucket`; a line
    // drawn along the label would interleave series instead of walking time.
    expect(labelColumn(metric("mesh_trend"))).toBe("mesh");
    expect(axisColumn(metric("mesh_trend"))).toBe("bucket");
    expect(defaultEncoding(metric("mesh_trend"), "line")).toEqual({ x: "bucket", y: "count" });
  });

  it("gives a single record its measure and no axis", () => {
    expect(labelColumn(metric("perf_summary"))).toBeUndefined();
    expect(measureColumn(metric("perf_summary"))).toBe("avg_fps");
    expect(defaultEncoding(metric("perf_summary"), "stat")).toEqual({ y: "avg_fps" });
  });
});
