/**
 * The insight primitives themselves (ADR 0051 §4, design sketch §D).
 *
 * Four things are pinned here, and they are the four ways `baseline` / `movers`
 * could go wrong without any SQL being involved:
 *
 * 1. **The measure catalog agrees with the registry.** Every bucket measure
 *    stands for a real metric's real `comparable.primary`. A measure that
 *    silently described a different column would make `baseline` report a
 *    "normal" the metric's own endpoint never produces.
 * 2. **`baseline` reduces a known series to known numbers.**
 * 3. **`movers` ranks by robust z and never dignifies a small sample.** The
 *    acceptance criterion of the issue, asserted directly.
 * 4. **Windows resolve to whole buckets**, so the current partial day cannot
 *    masquerade as a collapse and the reference really is an equal window.
 *
 * The bucket-series *query* is covered on all four dialects by the parity cases
 * (`src/parity/cases.ts`, `metricBuckets:*`); everything below is pure.
 */

import { describe, expect, it } from "vitest";
import { allMetrics, getMetric } from "@uptimizr/metrics";
import {
  BUCKETABLE_METRIC_IDS,
  BUCKET_MEASURES,
  MOVERS_DEFAULT_METRICS,
  MOVERS_MAX_METRICS,
  bucketMeasureFor,
  isBucketGrain,
  isBucketableMetric,
} from "../insights/measures.js";
import { computeBaseline } from "../insights/baseline.js";
import {
  computeMover,
  rankMovers,
  referenceSpread,
  rollupWindow,
  type MoverInput,
} from "../insights/movers.js";
import {
  DAY_MS,
  floorToBucket,
  inWindow,
  resolveBaselineWindow,
  resolveMoversWindows,
  spanningWindow,
} from "../insights/windows.js";
import type { MetricBucketRow } from "../insights/buckets.js";

/** A bucket row, tersely. */
function bucket(index: number, value: number | null, sample = 100): MetricBucketRow {
  return { bucket: index * DAY_MS, value, sample_size: sample };
}

describe("bucket measures — the catalog agrees with the registry", () => {
  it("only describes metrics that exist and declare comparison semantics", () => {
    for (const id of BUCKETABLE_METRIC_IDS) {
      const metric = getMetric(id);
      expect(metric, `${id} is not a registry metric`).toBeDefined();
      expect(
        metric?.comparable,
        `${id} has a bucket measure but declares no comparable semantics`,
      ).toBeDefined();
    }
  });

  it("reproduces each metric's comparable.primary, not some other column", () => {
    for (const id of BUCKETABLE_METRIC_IDS) {
      const metric = getMetric(id);
      const measure = bucketMeasureFor(id);
      expect(measure?.column, `${id}: measure column`).toBe(metric?.comparable?.primary);
      // And that column must really be a column of the metric's row.
      expect(metric?.columns[measure?.column ?? ""], `${id}: ${measure?.column}`).toBeDefined();
    }
  });

  it("declares a plausible aggregate for the column's unit", () => {
    for (const id of BUCKETABLE_METRIC_IDS) {
      const metric = getMetric(id);
      const measure = bucketMeasureFor(id);
      if (measure == null || metric == null) throw new Error(`no measure for ${id}`);
      const unit = metric.columns[measure.column]?.unit;
      if (measure.aggregate.kind === "sessions") {
        expect(unit, `${id} counts sessions`).toBe("sessions");
      }
      if (measure.aggregate.kind === "count") {
        expect(unit, `${id} counts events`).toBe("count");
      }
      // Additive quantities sum across buckets; levels average. Getting this
      // backwards would report a week's median FPS as ~400.
      const additive = unit === "count" || unit === "sessions" || unit === "ms";
      expect(measure.rollup, `${id} rollup for unit ${String(unit)}`).toBe(
        additive ? "sum" : "mean",
      );
    }
  });

  it("names only event types the schema knows, and non-empty predicate values", () => {
    const known = new Set(allMetrics().flatMap((metric) => metric.sourceChannels as string[]));
    for (const id of BUCKETABLE_METRIC_IDS) {
      const measure = bucketMeasureFor(id);
      for (const type of measure?.eventTypes ?? []) {
        expect(known.has(type), `${id}: unknown capture channel '${type}'`).toBe(true);
      }
      for (const predicate of measure?.where ?? []) {
        if (predicate.kind === "in") expect(predicate.values.length).toBeGreaterThan(0);
        if (predicate.kind === "geometry") expect([2, 3]).toContain(predicate.arity);
      }
    }
  });

  it("covers the metrics a mover scan defaults to, within the documented cap", () => {
    expect(MOVERS_DEFAULT_METRICS.length).toBeLessThanOrEqual(MOVERS_MAX_METRICS);
    expect(new Set(MOVERS_DEFAULT_METRICS).size, "duplicate default mover metric").toBe(
      MOVERS_DEFAULT_METRICS.length,
    );
    for (const id of MOVERS_DEFAULT_METRICS) {
      expect(isBucketableMetric(id), `${id} is scanned but has no bucket series`).toBe(true);
    }
  });

  it("answers for an unknown or non-bucketable metric without throwing", () => {
    expect(bucketMeasureFor("not_a_metric")).toBeUndefined();
    expect(isBucketableMetric("funnel")).toBe(false);
    // Prototype keys must not resolve to a measure.
    expect(bucketMeasureFor("toString")).toBeUndefined();
    expect(Object.keys(BUCKET_MEASURES).length).toBe(BUCKETABLE_METRIC_IDS.length);
  });

  it("recognises exactly the two supported grains", () => {
    expect(isBucketGrain("day")).toBe(true);
    expect(isBucketGrain("hour")).toBe(true);
    expect(isBucketGrain("week")).toBe(false);
  });
});

describe("baseline — a known series reduces to known numbers", () => {
  // The same skewed series the statistics suite uses, as five daily buckets.
  const series = [10, 12, 11, 13, 50].map((value, index) => bucket(index, value, 20));

  it("reports centre, spread, range and drift", () => {
    const row = computeBaseline("perf_summary", "lobby", series);
    expect(row.metric).toBe("perf_summary");
    expect(row.scene).toBe("lobby");
    expect(row.buckets).toBe(5);
    expect(row.mean).toBeCloseTo(19.2, 6);
    expect(row.median).toBe(12);
    expect(row.mad).toBe(1);
    expect(row.p10).toBeCloseTo(10.4, 6);
    expect(row.p90).toBeCloseTo(35.2, 6);
    expect(row.slope).toBeCloseTo(8.1, 6);
    expect(row.sampleSize).toBe(100);
  });

  it("is independent of the order the store returned buckets in", () => {
    const shuffled = [series[3], series[0], series[4], series[2], series[1]] as MetricBucketRow[];
    expect(computeBaseline("perf_summary", "lobby", shuffled)).toEqual(
      computeBaseline("perf_summary", "lobby", series),
    );
  });

  it("counts a null-valued bucket's sample but leaves it out of the statistics", () => {
    // A bucket whose aggregate was SQL-NULL over its rows: the events happened,
    // they just produced no value for this measure.
    const row = computeBaseline("perf_summary", undefined, [
      bucket(0, 10, 7),
      bucket(1, null, 3),
      bucket(2, 20, 5),
    ]);
    expect(row.buckets).toBe(2);
    expect(row.mean).toBe(15);
    expect(row.sampleSize).toBe(15);
    expect(row.scene).toBe("");
  });

  it("reports nothing rather than zero for an empty window", () => {
    const row = computeBaseline("perf_summary", "lobby", []);
    expect(row.buckets).toBe(0);
    expect(row.sampleSize).toBe(0);
    for (const key of ["mean", "median", "mad", "p10", "p90", "slope"] as const) {
      expect(row[key], key).toBeNull();
    }
  });

  it("has no slope from a single bucket", () => {
    const row = computeBaseline("perf_summary", "lobby", [bucket(0, 42, 9)]);
    expect(row.median).toBe(42);
    expect(row.mad).toBe(0);
    expect(row.slope).toBeNull();
  });
});

describe("movers — ranking, and what a small sample is allowed to claim", () => {
  /** A mover input from bare numbers. */
  function mover(
    metric: string,
    current: readonly number[],
    reference: readonly number[],
    overrides: Partial<MoverInput> = {},
  ): MoverInput {
    return {
      metric,
      direction: "neutral",
      minSample: 30,
      rollup: "sum",
      current: current.map((value, index) => bucket(index, value, 50)),
      reference: reference.map((value, index) => bucket(index - current.length, value, 50)),
      ...overrides,
    };
  }

  it("rolls additive quantities up by sum and levels by mean", () => {
    expect(rollupWindow([1, 2, 3], "sum")).toBe(6);
    expect(rollupWindow([1, 2, 3], "mean")).toBe(2);
    expect(rollupWindow([], "sum")).toBeNull();
  });

  it("floors the reference spread at a fraction of its level", () => {
    // A real MAD is well above 1% of the level, so the floor does not bind…
    expect(referenceSpread([10, 12, 8, 10])).toBe(1);
    // …but a one-bucket (or perfectly flat) reference has a MAD of exactly 0,
    // and without a floor every such metric would score in the billions and the
    // ranking would degenerate into comparing raw deltas across units.
    expect(referenceSpread([60])).toBeCloseTo(0.6, 12);
    expect(referenceSpread([200, 200, 200])).toBeCloseTo(2, 12);
    // Flat at zero has no level to floor against — that case falls through to
    // the epsilon in `robustZ`, deliberately.
    expect(referenceSpread([0, 0])).toBe(0);
    expect(referenceSpread([])).toBeNull();
  });

  it("keeps z readable against a single-bucket reference", () => {
    // reference 60 (one bucket) → spread floored to 0.6, so a 15-point drop is
    // -25 rather than -1.5e10.
    const row = computeMover(mover("perf_summary", [45], [60], { rollup: "mean" }));
    expect(row.z).toBeCloseTo(-25, 4);
  });

  it("computes the delta, its relative size and its robust z", () => {
    // reference buckets 10, 12, 8, 10 → sum 40, median 10, MAD 1
    // current buckets 30, 30 → sum 60 → delta +20 → z = 20 / (1 + eps) ≈ 20
    const row = computeMover(mover("list_sessions", [30, 30], [10, 12, 8, 10]));
    expect(row.current).toBe(60);
    expect(row.previous).toBe(40);
    expect(row.delta).toBe(20);
    expect(row.deltaPct).toBeCloseTo(0.5, 6);
    expect(row.z).toBeCloseTo(20, 4);
    expect(row.aboveMinSample).toBe(true);
    expect(row.sampleSize).toBe(100);
    expect(row.dimensionValue).toBeNull();
  });

  it("carries the registry's direction without confusing it with the sign of the move", () => {
    const row = computeMover(
      mover("error_heatmap", [40], [10], { direction: "down", rollup: "sum" }),
    );
    // Errors rose. `direction: "down"` says a rise is bad — it is not the
    // direction of the move, which is the sign of `delta`.
    expect(row.direction).toBe("down");
    expect(row.delta).toBeGreaterThan(0);
  });

  it("flags a sub-minSample window instead of dropping it, and ranks it last", () => {
    const tiny = mover("dead_clicks", [9], [1], { minSample: 30 });
    // One bucket of 5 events: real arithmetic, not evidence.
    const thin: MoverInput = { ...tiny, current: [bucket(0, 9, 5)] };
    const solid = mover("list_sessions", [20], [10]);
    const rows = rankMovers([thin, solid], 10);

    const thinRow = rows.find((row) => row.metric === "dead_clicks");
    expect(thinRow, "the small-sample row is reported, not dropped").toBeDefined();
    expect(thinRow?.aboveMinSample).toBe(false);
    expect(thinRow?.delta).toBe(8);
    // ...but it never leads: a gated mover always outranks an ungated one,
    // whatever their z-scores are.
    expect(rows[0]?.metric).toBe("list_sessions");
    expect(rows[0]?.aboveMinSample).toBe(true);
    expect(rows.indexOf(thinRow!)).toBeGreaterThan(0);
  });

  it("splits risers from fallers and caps each half at the limit", () => {
    const inputs = [
      mover("a", [100], [10]),
      mover("b", [90], [10]),
      mover("c", [80], [10]),
      mover("d", [1], [50]),
      mover("e", [2], [50]),
      mover("f", [10], [10]),
    ];
    const rows = rankMovers(inputs, 2);
    const ids = rows.map((row) => row.metric);
    // Two risers (the biggest), then two fallers, then the flat one.
    expect(ids.slice(0, 2)).toEqual(["a", "b"]);
    expect(new Set(ids.slice(2, 4))).toEqual(new Set(["d", "e"]));
    expect(ids).toContain("f");
    expect(ids).not.toContain("c");
    // A metric is reported at most once.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ranks by how unusual a move is, not by how big it is", () => {
    // `steady` normally sits on 10 and moved to 16: +6 against a MAD of 0 buckets.
    const steady = mover("steady", [16], [10, 10, 10, 10]);
    // `volatile` moved by twice as much, but it swings that far every other day.
    const volatile = mover("volatile", [52], [10, 60, 10, 60]);
    const rows = rankMovers([steady, volatile], 5);
    expect(rows[0]?.metric).toBe("steady");
    expect(Math.abs(rows[0]?.z ?? 0)).toBeGreaterThan(Math.abs(rows[1]?.z ?? 0));
  });

  it("reports an undetermined move rather than calling it flat", () => {
    // No reference data at all: previous, delta and z are unknown.
    const row = computeMover(mover("list_sessions", [20], []));
    expect(row.previous).toBeNull();
    expect(row.delta).toBeNull();
    expect(row.deltaPct).toBeNull();
    expect(row.z).toBeNull();
    // It still appears in the result, at the end.
    const rows = rankMovers([mover("list_sessions", [20], [])], 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.z).toBeNull();
  });

  it("returns nothing for a zero limit", () => {
    expect(rankMovers([mover("a", [100], [10])], 0)).toEqual([]);
  });
});

describe("insight windows — whole buckets, and a truly equal reference", () => {
  const noon = Date.UTC(2024, 5, 16, 12, 34, 56);

  it("snaps an instant down to its bucket start", () => {
    expect(floorToBucket(noon, "day")).toBe(Date.UTC(2024, 5, 16));
    expect(floorToBucket(noon, "hour")).toBe(Date.UTC(2024, 5, 16, 12));
  });

  it("defaults baseline to the last complete buckets before now", () => {
    const window = resolveBaselineWindow({ bucket: "day", now: noon });
    // The partial day in progress is excluded: today's third-of-a-day would read
    // as a collapse against 27 whole days.
    expect(window.until).toBe(Date.UTC(2024, 5, 16));
    expect(window.until - window.since).toBe(28 * DAY_MS);
  });

  it("lets an explicit since win over the window shorthand", () => {
    const since = Date.UTC(2024, 5, 1);
    const window = resolveBaselineWindow({
      since,
      until: Date.UTC(2024, 5, 16),
      windowDays: 28,
      bucket: "day",
      now: noon,
    });
    expect(window.since).toBe(since);
    expect(window.until).toBe(Date.UTC(2024, 5, 16));
  });

  it("never collapses to an empty baseline window", () => {
    const window = resolveBaselineWindow({
      since: noon,
      until: noon,
      bucket: "day",
      now: noon,
    });
    expect(window.until).toBeGreaterThan(window.since);
    expect(window.until - window.since).toBe(DAY_MS);
  });

  it("defaults movers' reference to the equal window immediately before", () => {
    const { range, reference } = resolveMoversWindows({ bucket: "day", now: noon });
    expect(range.until).toBe(Date.UTC(2024, 5, 16));
    expect(range.until - range.since).toBe(7 * DAY_MS);
    // Contiguous and exactly as long — that is what makes "vs last week" fair.
    expect(reference.until).toBe(range.since);
    expect(reference.until - reference.since).toBe(range.until - range.since);
  });

  it("keeps an explicit refUntil but still infers an equal length", () => {
    const { range, reference } = resolveMoversWindows({
      bucket: "day",
      now: noon,
      refUntil: Date.UTC(2024, 4, 1),
    });
    expect(reference.until).toBe(Date.UTC(2024, 4, 1));
    expect(reference.until - reference.since).toBe(range.until - range.since);
  });

  it("covers both windows with one spanning range, and attributes buckets by start", () => {
    const { range, reference } = resolveMoversWindows({ bucket: "day", now: noon });
    const span = spanningWindow(range, reference);
    expect(span.since).toBe(reference.since);
    expect(span.until).toBe(range.until);
    // Every bucket start in the span falls in exactly one of the two windows.
    for (let t = span.since; t < span.until; t += DAY_MS) {
      expect(Number(inWindow(t, range)) + Number(inWindow(t, reference)), String(t)).toBe(1);
    }
  });
});
