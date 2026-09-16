/**
 * The `format=table | summary` summariser (ADR 0051 §2, design sketch §B.1).
 *
 * Three things are being pinned down here:
 *
 * 1. **Shape per grain** — a leaderboard summarises as ranked rows, a time
 *    series as a trend, a voxel cloud as clusters, a single-row metric as the
 *    record plus its rates. Each is checked against fixed inputs, including the
 *    degenerate ones (no rows, one row, a tie, an all-null measure) where a
 *    naive implementation produces `NaN`, `undefined` or a divide-by-zero.
 * 2. **Determinism** — the cluster merge must be a pure function of the *set* of
 *    cells, not of the order the store returned them in. Every fixture is run
 *    twice and re-run against a rotated copy of its input.
 * 3. **Boundedness and safety across the whole registry** — every metric, not
 *    just the hand-picked ones, must produce a summary that fits inside its
 *    `limits.maxSummaryRows` and a `reading` free of `undefined` and `NaN`.
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { allMetrics, getMetric, type MetricDefinition } from "@uptimizr/metrics";
import {
  clusterCells,
  summarizeRows,
  tableResult,
  wilsonInterval,
  type ClusterSummary,
  type RankedSummary,
  type RecordSummary,
  type ResultRow,
  type SeriesSummary,
} from "../query/summary/index.js";

/** Rotate an array so the same set arrives in a different order. */
function rotate<T>(items: readonly T[], by: number): T[] {
  const offset = ((by % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function metric(id: string): MetricDefinition {
  const found = getMetric(id);
  if (found == null) throw new Error(`unknown metric ${id}`);
  return found;
}

describe("clusterCells", () => {
  /**
   * Two 2×2 blocks of weight 10 separated by a gap, plus a single weight-1 cell
   * bridging them. The bridge is below the mean weight per occupied cell, so it
   * must not fuse the two hotspots into one.
   */
  const twoBlocks = [
    { coords: [0, 0], weight: 10 },
    { coords: [0, 1], weight: 10 },
    { coords: [1, 0], weight: 10 },
    { coords: [1, 1], weight: 12 },
    { coords: [3, 0], weight: 1 },
    { coords: [5, 0], weight: 9 },
    { coords: [5, 1], weight: 9 },
    { coords: [6, 0], weight: 9 },
    { coords: [6, 1], weight: 9 },
  ];

  it("merges adjacent cells above the density threshold into ranked hotspots", () => {
    const result = clusterCells(twoBlocks);
    expect(result.occupiedCells).toBe(9);
    expect(result.totalWeight).toBe(79);
    expect(result.clusters).toHaveLength(2);
    const [first, second] = result.clusters;
    expect(first?.weight).toBe(42);
    expect(first?.cells).toBe(4);
    expect(first?.extent).toEqual({ min: [0, 0], max: [1, 1] });
    expect(second?.weight).toBe(36);
    // The sub-threshold bridge cell is reported, never silently dropped.
    expect(result.rest).toEqual({ clusters: 0, cells: 1, weight: 1 });
  });

  it("is a pure function of the cell set, not of row order", () => {
    const reference = JSON.stringify(clusterCells(twoBlocks));
    for (let by = 1; by < twoBlocks.length; by++) {
      expect(JSON.stringify(clusterCells(rotate(twoBlocks, by)))).toBe(reference);
    }
  });

  it("uses the 8-neighbourhood in 2D, so a diagonal touch merges", () => {
    const diagonal = [
      { coords: [0, 0], weight: 5 },
      { coords: [1, 1], weight: 5 },
    ];
    expect(clusterCells(diagonal).clusters).toHaveLength(1);
  });

  it("uses the 26-neighbourhood in 3D, so a corner touch merges", () => {
    const corner = [
      { coords: [0, 0, 0], weight: 5 },
      { coords: [1, 1, 1], weight: 5 },
      { coords: [4, 4, 4], weight: 5 },
    ];
    const result = clusterCells(corner);
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]?.cells).toBe(2);
  });

  it("weights the centroid by cell weight", () => {
    const skewed = [
      { coords: [0, 0], weight: 1 },
      { coords: [2, 0], weight: 3 },
    ];
    // Threshold 0 keeps both; they are not adjacent, so ranking, not merging.
    const result = clusterCells(skewed, { densityThreshold: 0 });
    expect(result.clusters.map((cluster) => cluster.centroid)).toEqual([
      [2, 0],
      [0, 0],
    ]);
  });

  it("sums duplicate coordinates before clustering", () => {
    const duplicated = [
      { coords: [0, 0], weight: 2 },
      { coords: [0, 0], weight: 3 },
    ];
    const result = clusterCells(duplicated);
    expect(result.occupiedCells).toBe(1);
    expect(result.clusters[0]?.weight).toBe(5);
  });

  it("ignores empty, negative and non-finite cells", () => {
    const result = clusterCells([
      { coords: [0, 0], weight: 0 },
      { coords: [1, 0], weight: -4 },
      { coords: [2, 0], weight: Number.NaN },
    ]);
    expect(result).toEqual({
      clusters: [],
      occupiedCells: 0,
      totalWeight: 0,
      densityThreshold: 0,
      rest: { clusters: 0, cells: 0, weight: 0 },
    });
  });

  it("caps the reported clusters and accounts for the rest", () => {
    const scattered = [0, 3, 6, 9, 12].map((x) => ({ coords: [x, 0], weight: 10 }));
    const result = clusterCells(scattered, { maxClusters: 2 });
    expect(result.clusters).toHaveLength(2);
    expect(result.rest).toEqual({ clusters: 3, cells: 3, weight: 30 });
  });
});

describe("wilsonInterval", () => {
  it("brackets the point estimate and stays inside 0..1", () => {
    const interval = wilsonInterval(50, 100);
    expect(interval).not.toBeNull();
    expect(interval!.low).toBeGreaterThan(0.39);
    expect(interval!.high).toBeLessThan(0.61);
  });

  it("never goes below zero at an extreme proportion", () => {
    const interval = wilsonInterval(1, 10_000);
    expect(interval!.low).toBeGreaterThanOrEqual(0);
    expect(interval!.high).toBeLessThanOrEqual(1);
  });

  it("is undefined without a denominator", () => {
    expect(wilsonInterval(1, 0)).toBeNull();
    expect(wilsonInterval(5, 4)).toBeNull();
  });
});

describe("summarizeRows — ranked grains", () => {
  const rows: ResultRow[] = [
    { mesh: "door_left", count: 20 },
    { mesh: "checkout_button", count: 60 },
    { mesh: "floor", count: 10 },
    { mesh: "wall", count: 10 },
  ];

  it("ranks by the measure and reports shares of the total", () => {
    const summary = summarizeRows("top_meshes", rows, {
      range: { since: 1, until: 2 },
      filters: { session: "s-1", format: "summary" },
      maxRows: 2,
    }) as RankedSummary;

    expect(summary.kind).toBe("ranked");
    expect(summary.metric).toBe("top_meshes");
    expect(summary.range).toEqual({ since: 1, until: 2 });
    // `format` never appears in the echoed filters: it narrows nothing.
    expect(summary.filters).toEqual({ session: "s-1" });
    expect(summary.total).toBe(100);
    expect(summary.measure).toEqual({ column: "count", unit: "count", additive: true });
    expect(summary.top.map((row) => row.label)).toEqual(["checkout_button", "door_left"]);
    expect(summary.top[0]?.share).toBeCloseTo(0.6);
    expect(summary.rest).toEqual({ rows: 2, value: 20, share: 0.2 });
    expect(summary.confidence?.kind).toBe("wilson");
    expect(summary.top[0]?.shareInterval?.low).toBeLessThan(0.6);
    expect(summary.top[0]?.shareInterval?.high).toBeGreaterThan(0.6);
    expect(summary.reading).toContain("checkout_button");
    expect(summary.reading).toContain("60%");
  });

  it("is bounded by the registry cap", () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      mesh: `mesh_${index}`,
      count: 200 - index,
    }));
    const summary = summarizeRows("top_meshes", many) as RankedSummary;
    expect(summary.top.length).toBe(metric("top_meshes").limits.maxSummaryRows);
    expect(summary.rest.rows).toBe(200 - summary.top.length);
  });

  it("breaks ties by label so the order is a function of the row set", () => {
    const tied: ResultRow[] = [
      { mesh: "b", count: 5 },
      { mesh: "a", count: 5 },
      { mesh: "c", count: 5 },
    ];
    const forward = summarizeRows("top_meshes", tied) as RankedSummary;
    const rotated = summarizeRows("top_meshes", rotate(tied, 2)) as RankedSummary;
    expect(forward.top.map((row) => row.label)).toEqual(["a", "b", "c"]);
    expect(JSON.stringify(rotated)).toBe(JSON.stringify(forward));
  });

  it("reports no total or share when the measure cannot be summed", () => {
    // `p50_fps` is an FPS value: adding two devices' medians means nothing.
    const summary = summarizeRows("perf_by_device", [
      {
        engine: "babylon",
        is_mobile: 0,
        renderer: "a",
        browser: "c",
        os: "w",
        sessions: 3,
        samples: 30,
        p50_fps: 60,
      },
      {
        engine: "babylon",
        is_mobile: 1,
        renderer: "b",
        browser: "c",
        os: "w",
        sessions: 2,
        samples: 10,
        p50_fps: 30,
      },
    ]) as RankedSummary;
    expect(summary.total).toBeNull();
    expect(summary.measure?.additive).toBe(false);
    expect(summary.top.every((row) => row.share === null)).toBe(true);
    expect(summary.top[0]?.shareInterval).toBeUndefined();
    expect(summary.confidence).toBeUndefined();
    expect(summary.reading).toContain("Shares are not reported");
  });

  it("survives an all-null measure", () => {
    const summary = summarizeRows("top_meshes", [
      { mesh: "a", count: null },
      { mesh: "b", count: null },
    ]) as RankedSummary;
    expect(summary.total).toBeNull();
    expect(summary.top.map((row) => row.value)).toEqual([null, null]);
    expect(summary.rest).toEqual({ rows: 0, value: null, share: null });
    expect(summary.reading).not.toMatch(/undefined|NaN/);
  });

  it("says so, rather than dividing by zero, when nothing matched", () => {
    const summary = summarizeRows("top_meshes", []) as RankedSummary;
    expect(summary.top).toEqual([]);
    expect(summary.total).toBeNull();
    expect(summary.reading).toBe(
      "Most-interacted meshes: no rows matched the selected range and filters.",
    );
    expect(summary.caveats.at(-1)).toContain("No rows matched");
  });

  it("offers a drill hint only for a filter the metric accepts", () => {
    // `mesh_sources` accepts `source` but not `mesh`, so only `source` is offered.
    const summary = summarizeRows("mesh_sources", [
      { mesh: "door", source: "mouse", count: 4 },
    ]) as RankedSummary;
    expect(summary.top[0]?.drill).toEqual({ source: "mouse" });
  });
});

describe("summarizeRows — bucket grains", () => {
  const rising: ResultRow[] = [
    { bucket: 3000, events: 30, avg_fps: 60 },
    { bucket: 1000, events: 10, avg_fps: 60 },
    { bucket: 2000, events: 20, avg_fps: 60 },
  ];

  it("orders by the axis column and reports the trend", () => {
    const summary = summarizeRows("timeseries", rising) as SeriesSummary;
    expect(summary.kind).toBe("series");
    expect(summary.series.axis).toBe("bucket");
    expect(summary.series.points).toBe(3);
    expect(summary.series.first).toBe(10);
    expect(summary.series.last).toBe(30);
    expect(summary.series.firstLabel).toBe("1000");
    expect(summary.series.min).toBe(10);
    expect(summary.series.max).toBe(30);
    expect(summary.series.trend).toBe("up");
    expect(summary.series.slope).toBe(10);
    expect(summary.total).toBe(60);
    expect(summary.reading).toContain("trend up");
  });

  it("calls a flat series flat and a falling one down", () => {
    const flat = summarizeRows("timeseries", [
      { bucket: 1, events: 100, avg_fps: 60 },
      { bucket: 2, events: 101, avg_fps: 60 },
      { bucket: 3, events: 100, avg_fps: 60 },
    ]) as SeriesSummary;
    expect(flat.series.trend).toBe("flat");

    const falling = summarizeRows(
      "timeseries",
      rotate(rising, 1).map((row) => ({
        ...row,
        events: 40 - (row.events as number),
      })),
    ) as SeriesSummary;
    expect(falling.series.trend).toBe("down");
  });

  it("collapses a multi-series bucket metric onto its axis", () => {
    // `mesh_trend` is one row per (mesh, bucket) and labels rows by `mesh`, so
    // the `axis` flag — not `label` — is what makes this walk time.
    const summary = summarizeRows("mesh_trend", [
      { mesh: "a", bucket: 10, count: 1 },
      { mesh: "b", bucket: 10, count: 2 },
      { mesh: "a", bucket: 20, count: 5 },
    ]) as SeriesSummary;
    expect(summary.series.axis).toBe("bucket");
    expect(summary.series.points).toBe(2);
    expect(summary.series.first).toBe(3);
    expect(summary.series.last).toBe(5);
  });

  it("refuses to call a single point a trend", () => {
    const summary = summarizeRows("timeseries", [
      { bucket: 1, events: 5, avg_fps: 60 },
    ]) as SeriesSummary;
    expect(summary.series.points).toBe(1);
    expect(summary.series.slope).toBeNull();
    expect(summary.series.trend).toBe("flat");
    expect(summary.reading).toContain("too few points");
  });

  it("handles an empty series", () => {
    const summary = summarizeRows("timeseries", []) as SeriesSummary;
    expect(summary.series.points).toBe(0);
    expect(summary.series.first).toBeNull();
    expect(summary.reading).not.toMatch(/undefined|NaN/);
  });
});

describe("summarizeRows — spatial grains", () => {
  const voxels: ResultRow[] = [
    { vx: 0, vy: 0, vz: 0, count: 10 },
    { vx: 1, vy: 0, vz: 0, count: 10 },
    { vx: 8, vy: 0, vz: 0, count: 10 },
    { vx: 9, vy: 0, vz: 0, count: 10 },
  ];

  it("summarises a voxel cloud as clusters, not cells", () => {
    const summary = summarizeRows("world_heatmap", voxels, { cellSize: 0.5 }) as ClusterSummary;
    expect(summary.kind).toBe("clusters");
    expect(summary.axes).toEqual(["vx", "vy", "vz"]);
    expect(summary.occupiedCells).toBe(4);
    expect(summary.clusters).toHaveLength(2);
    expect(summary.clusters[0]?.weight).toBe(20);
    expect(summary.clusters[0]?.share).toBeCloseTo(0.5);
    // A world-space box the caller can send straight back as `region`.
    expect(summary.clusters[0]?.drill).toEqual({ region: "0,0,0,1,0.5,0.5" });
    expect(summary.reading).toContain("hotspots");
  });

  it("omits the region drill when no cell size is known", () => {
    const summary = summarizeRows("world_heatmap", voxels) as ClusterSummary;
    expect(summary.clusters[0]?.drill).toBeUndefined();
  });

  it("weighs a spatial metric by its count column, not by an average", () => {
    // `perf_heatmap` measures `avg_fps` but counts `samples`.
    const summary = summarizeRows("perf_heatmap", [
      { vx: 0, vy: 0, vz: 0, samples: 100, avg_fps: 30, min_fps: 20 },
      { vx: 5, vy: 0, vz: 0, samples: 1, avg_fps: 120, min_fps: 120 },
    ]) as ClusterSummary;
    expect(summary.measure?.column).toBe("samples");
    expect(summary.clusters[0]?.weight).toBe(100);
  });

  it("clusters a 2D metric on its first two index columns", () => {
    const summary = summarizeRows("position_heatmap", [
      { gx: 0, gz: 0, avg_y: 1.5, count: 4 },
      { gx: 0, gz: 1, avg_y: 1.5, count: 4 },
    ]) as ClusterSummary;
    expect(summary.axes).toEqual(["gx", "gz"]);
    expect(summary.clusters).toHaveLength(1);
  });

  it("is order-independent end to end", () => {
    const reference = JSON.stringify(summarizeRows("world_heatmap", voxels, { cellSize: 0.5 }));
    for (let by = 1; by < voxels.length; by++) {
      expect(
        JSON.stringify(summarizeRows("world_heatmap", rotate(voxels, by), { cellSize: 0.5 })),
      ).toBe(reference);
    }
  });

  it("handles an empty grid", () => {
    const summary = summarizeRows("world_heatmap", []) as ClusterSummary;
    expect(summary.occupiedCells).toBe(0);
    expect(summary.clusters).toEqual([]);
    expect(summary.reading).not.toMatch(/undefined|NaN/);
  });
});

describe("summarizeRows — single-row grains", () => {
  it("returns the row itself with its declared rates resolved", () => {
    const summary = summarizeRows("dead_clicks", [
      { total_clicks: 200, dead_clicks: 25 },
    ]) as RecordSummary;
    expect(summary.kind).toBe("record");
    expect(summary.record).toEqual({ total_clicks: 200, dead_clicks: 25 });
    expect(summary.rates).toEqual({
      dead_clicks: { value: 0.125, numerator: "dead_clicks", denominator: "total_clicks" },
    });
    expect(summary.total).toBe(25);
    expect(summary.reading).toContain("12.5%");
  });

  it("keeps a null aggregate null rather than calling it zero", () => {
    const summary = summarizeRows("perf_summary", [
      { samples: 0, avg_fps: null, min_fps: null, p50_fps: null },
    ]) as RecordSummary;
    expect(summary.record.avg_fps).toBeNull();
    expect(summary.total).toBeNull();
    expect(summary.reading).toContain("n/a");
    expect(summary.reading).not.toMatch(/undefined|NaN/);
  });

  it("handles a project metric that returned nothing at all", () => {
    const summary = summarizeRows("dead_clicks", []) as RecordSummary;
    expect(summary.record).toEqual({});
    expect(summary.rates).toEqual({});
    expect(summary.reading).toContain("no rows matched");
  });
});

describe("tableResult", () => {
  it("echoes only the filters the metric declares, never arbitrary request keys", () => {
    // `top_meshes` accepts `session` but not `scene`; unknown keys (and
    // prototype-shaped ones) must never become properties of the envelope.
    const table = tableResult("top_meshes", [{ mesh: "a", count: 1 }], {
      filters: { session: "s-1", scene: "lobby", __proto__: "x", constructor: "y" },
    });
    expect(table?.meta.filters).toEqual({ session: "s-1" });
  });

  it("wraps the rows without touching them", () => {
    const rows = [{ mesh: "a", count: 1 }];
    const table = tableResult("top_meshes", rows, {
      range: { since: 5 },
      filters: { session: "s-1", format: "table" },
      limit: 10,
    });
    expect(table?.rows).toBe(rows);
    expect(table?.meta).toEqual({
      metric: "top_meshes",
      range: { since: 5, until: null },
      filters: { session: "s-1" },
      sampleSize: { sessions: null, events: 1 },
      rows: 1,
      truncated: false,
      limits: { maxRows: 1000, maxSummaryRows: 10 },
    });
  });

  it("flags truncation when the row cap was reached", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({ mesh: `m${index}`, count: 1 }));
    expect(tableResult("top_meshes", rows, { limit: 3 })?.meta.truncated).toBe(true);
    expect(tableResult("top_meshes", rows, { limit: 4 })?.meta.truncated).toBe(false);
  });

  it("counts sessions as rows for a session-grain metric", () => {
    const table = tableResult("list_sessions", [
      { session_id: "a", visitor_id: "v", events: 3, started_at: "", ended_at: "" },
      { session_id: "b", visitor_id: "v", events: 4, started_at: "", ended_at: "" },
    ]);
    expect(table?.meta.sampleSize).toEqual({ sessions: 2, events: 7 });
  });

  it("returns null for an unknown metric", () => {
    expect(tableResult("not_a_metric" as never, [])).toBeNull();
    expect(summarizeRows("not_a_metric" as never, [])).toBeNull();
  });
});

// --- Whole-registry guarantees -------------------------------------------

/**
 * A row that satisfies a metric's declared schema, without needing a store: each
 * column is probed with a number and then a string, so numeric columns get a
 * number and label columns a stable synthetic name.
 */
function syntheticRow(metric: MetricDefinition, index: number): ResultRow {
  const row: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(metric.row.shape)) {
    const column = schema as z.ZodType;
    if (column.safeParse(index + 1).success) row[name] = index + 1;
    else if (column.safeParse(`value_${index}`).success) row[name] = `value_${index}`;
    else row[name] = null;
  }
  return row;
}

describe("every registry metric summarises safely", () => {
  for (const definition of allMetrics()) {
    it(`${definition.id} stays bounded and readable`, () => {
      for (const count of [0, 1, 2, 40]) {
        const rows = Array.from({ length: count }, (_, index) => syntheticRow(definition, index));
        const summary = summarizeRows(definition, rows, {
          range: { since: 1, until: 2 },
          cellSize: 0.5,
        });
        expect(summary, `${definition.id} produced no summary`).not.toBeNull();
        if (summary == null) continue;

        // Bounded: the whole point of the envelope.
        const cap = definition.limits.maxSummaryRows;
        if (summary.kind === "ranked") expect(summary.top.length).toBeLessThanOrEqual(cap);
        if (summary.kind === "clusters") expect(summary.clusters.length).toBeLessThanOrEqual(cap);

        // Readable: templated prose, never a leaked placeholder.
        expect(summary.reading, `${definition.id} @ ${count} rows`).not.toMatch(/undefined|NaN/);
        expect(summary.reading.length).toBeGreaterThan(0);
        expect(summary.caveats.length).toBeGreaterThan(0);

        // Serialisable: a summary is an HTTP response body.
        expect(() => JSON.stringify(summary)).not.toThrow();
        expect(JSON.stringify(summary)).not.toContain("NaN");
      }
    });
  }
});
