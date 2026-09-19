/**
 * `insight_scene_health` (#307) — the factor catalog, the normalisation and the
 * weighted score.
 *
 * The acceptance criterion this file exists to enforce is **traceability**: a
 * score has to be reconstructible from the row that carries it. So the tests
 * do the weighted mean by hand and compare, rather than snapshotting a number.
 */

import { describe, expect, it } from "vitest";
import {
  BUCKET_MEASURE_VARIANTS,
  HEALTH_DEFAULT_WEIGHTS,
  HEALTH_FACTORS,
  HEALTH_FACTOR_IDS,
  HEALTH_Z_SPAN,
  bucketVariantFor,
  computeSceneHealth,
  normaliseFactor,
  rankSceneHealth,
  resolveBucketMeasure,
  resolveWeights,
  type HealthFactorInput,
  type MetricBucketRow,
} from "../index.js";
import { getMetric } from "@uptimizr/metrics";

/** Bucket rows from a bare list of values, one per day. */
function series(values: readonly number[]): MetricBucketRow[] {
  return values.map((value, index) => ({
    bucket: index * 86_400_000,
    value,
    sample_size: Math.max(1, Math.round(value)),
  }));
}

/** A level factor's input: current window, then the baseline window. */
function levelInput(current: readonly number[], baseline: readonly number[]): HealthFactorInput {
  return {
    current: { numerator: series(current) },
    baseline: { numerator: series(baseline) },
  };
}

/** A rate factor's input, as four series. */
function rateInput(
  current: [readonly number[], readonly number[]],
  baseline: [readonly number[], readonly number[]],
): HealthFactorInput {
  return {
    current: { numerator: series(current[0]), denominator: series(current[1]) },
    baseline: { numerator: series(baseline[0]), denominator: series(baseline[1]) },
  };
}

describe("the factor catalog", () => {
  it("names a real registry metric for every factor", () => {
    for (const factor of HEALTH_FACTORS) {
      expect(getMetric(factor.metric), `${factor.id} -> ${factor.metric}`).toBeDefined();
    }
  });

  it("declares every series it reads, so no factor can silently go dark", () => {
    for (const factor of HEALTH_FACTORS) {
      const numerator =
        factor.numerator == null
          ? resolveBucketMeasure(factor.metric)
          : bucketVariantFor(factor.metric, factor.numerator);
      expect(numerator, `${factor.id}: no numerator series`).toBeDefined();
      if (factor.denominator != null) {
        expect(
          bucketVariantFor(factor.metric, factor.denominator),
          `${factor.id}: no denominator series`,
        ).toBeDefined();
      }
    }
  });

  it("has unique factor ids and weights that sum to 1", () => {
    expect(new Set(HEALTH_FACTOR_IDS).size).toBe(HEALTH_FACTORS.length);
    const total = HEALTH_FACTORS.reduce((sum, factor) => sum + factor.weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("covers the six factors the design sketch names", () => {
    expect(HEALTH_FACTOR_IDS).toEqual([
      "perf_stability",
      "jank_rate",
      "error_rate",
      "dead_click_rate",
      "coverage",
      "xr_abandonment",
    ]);
  });

  it("keeps the variant catalog out of the bucketable set", () => {
    // `jank_rate` and `xr_abandonment` declare variants but have no main
    // measure: `baseline` and `movers` must keep rejecting them.
    for (const id of ["jank_rate", "xr_abandonment"] as const) {
      expect(BUCKET_MEASURE_VARIANTS[id]).toBeDefined();
      expect(resolveBucketMeasure(id)).toBeUndefined();
    }
  });
});

describe("normaliseFactor", () => {
  const baseline = [10, 12, 11, 13, 10, 12, 11];
  // median 11; MAD = median(|x - 11|) = median([1,1,0,2,1,1,0]) = 1; the 1%
  // floor (0.11) does not bind.

  it("scores the project norm at exactly 50", () => {
    expect(normaliseFactor(11, baseline, "up").score).toBe(50);
    expect(normaliseFactor(11, baseline, "down").score).toBe(50);
  });

  it("is linear in the robust z, with HEALTH_Z_SPAN deviations reaching the ends", () => {
    // +1 MAD above the median on an `up` factor: 50 + 50/4 = 62.5.
    expect(normaliseFactor(12, baseline, "up").score).toBeCloseTo(62.5, 10);
    // …and the same distance the other way on a `down` factor.
    expect(normaliseFactor(12, baseline, "down").score).toBeCloseTo(37.5, 10);
    expect(normaliseFactor(11 + HEALTH_Z_SPAN, baseline, "up").score).toBe(100);
    expect(normaliseFactor(11 - HEALTH_Z_SPAN, baseline, "up").score).toBe(0);
  });

  it("clamps rather than running off the scale", () => {
    expect(normaliseFactor(1000, baseline, "up").score).toBe(100);
    expect(normaliseFactor(-1000, baseline, "up").score).toBe(0);
  });

  it("reports the baseline centre it compared against", () => {
    expect(normaliseFactor(12, baseline, "up").centre).toBe(11);
  });

  it("returns null rather than 50 when there is no baseline", () => {
    expect(normaliseFactor(12, [], "up").score).toBeNull();
    expect(normaliseFactor(null, baseline, "up").score).toBeNull();
  });

  it("falls back to a verdict when the baseline has no spread at all", () => {
    // One bucket: no notion of "how unusual", only "better" or "worse".
    expect(normaliseFactor(5, [5], "up").score).toBe(50);
    expect(normaliseFactor(6, [5], "up").score).toBe(100);
    expect(normaliseFactor(6, [5], "down").score).toBe(0);
  });
});

describe("resolveWeights", () => {
  it("defaults to the declared weights", () => {
    expect(resolveWeights()).toEqual(HEALTH_DEFAULT_WEIGHTS);
  });

  it("overrides only the factors named", () => {
    const weights = resolveWeights({ error_rate: 0.6 });
    expect(weights.error_rate).toBe(0.6);
    expect(weights.perf_stability).toBe(HEALTH_DEFAULT_WEIGHTS.perf_stability);
  });

  it("ignores unknown ids and negative weights", () => {
    const weights = resolveWeights({ not_a_factor: 5, coverage: -1 });
    expect(weights.not_a_factor).toBeUndefined();
    expect(weights.coverage).toBe(HEALTH_DEFAULT_WEIGHTS.coverage);
  });
});

describe("computeSceneHealth", () => {
  it("reports every factor, whether or not it scored", () => {
    const row = computeSceneHealth({
      scene: "lobby",
      since: 0,
      until: 7 * 86_400_000,
      sampleSize: 120,
      inputs: {
        perf_stability: levelInput([40, 41, 39], [50, 51, 49, 50, 51, 49, 50]),
      },
    });
    expect(row.factors.map((factor) => factor.id)).toEqual(HEALTH_FACTOR_IDS);
    const scored = row.factors.filter((factor) => factor.score != null);
    expect(scored).toHaveLength(1);
    for (const factor of row.factors) {
      if (factor.score == null) expect(factor.note).toContain("Not scored");
    }
  });

  it("makes every factor traceable back to its metric and raw value", () => {
    const row = computeSceneHealth({
      scene: "lobby",
      since: 0,
      until: 7 * 86_400_000,
      sampleSize: 120,
      inputs: { perf_stability: levelInput([40, 42], [50, 51, 49, 50, 51, 49, 50]) },
    });
    const factor = row.factors.find((entry) => entry.id === "perf_stability");
    expect(factor?.metric).toBe("perf_summary");
    // Raw is the mean of the scene's bucket values…
    expect(factor?.raw).toBe(41);
    // …and `baseline` is the median of the project's, so the reader can do the
    // normalisation themselves: median 50, MAD 1, z = -9, clamped to 0.
    expect(factor?.baseline).toBe(50);
    expect(factor?.score).toBe(0);
    expect(factor?.unit).toBe("FPS");
  });

  it("computes a rate as the window ratio, not the mean of daily ratios", () => {
    // Day 1: 1 error over 1 session. Day 2: 1 error over 99 sessions.
    // The window rate is 2/100 = 0.02, not (1/1 + 1/99)/2 = 0.505.
    const row = computeSceneHealth({
      scene: "lobby",
      since: 0,
      until: 2 * 86_400_000,
      sampleSize: 100,
      inputs: {
        error_rate: rateInput(
          [
            [1, 1],
            [1, 99],
          ],
          [
            [1, 1, 1],
            [50, 50, 50],
          ],
        ),
      },
    });
    const factor = row.factors.find((entry) => entry.id === "error_rate");
    expect(factor?.raw).toBe(0.02);
  });

  it("takes the weighted mean over the factors that scored", () => {
    const row = computeSceneHealth({
      scene: "lobby",
      since: 0,
      until: 7 * 86_400_000,
      sampleSize: 120,
      inputs: {
        // 1 MAD better than the norm on an `up` factor → 62.5, weight 0.25.
        perf_stability: levelInput([51], [50, 51, 49, 50, 51, 49, 50]),
        // exactly at the norm on a `down` factor → 50, weight 0.25.
        error_rate: rateInput(
          [[2], [100]],
          [
            [2, 2, 2],
            [100, 100, 100],
          ],
        ),
      },
    });
    // The two remaining weights renormalise: (0.25*62.5 + 0.25*50) / 0.5.
    expect(row.score).toBeCloseTo(56.25, 6);
    const perf = row.factors.find((entry) => entry.id === "perf_stability");
    const errors = row.factors.find((entry) => entry.id === "error_rate");
    expect(perf?.score).toBeCloseTo(62.5, 6);
    expect(errors?.score).toBe(50);
    // The arithmetic is reproducible from the row alone.
    const weighted =
      (perf as { score: number; weight: number }).score * (perf as { weight: number }).weight +
      (errors as { score: number }).score * (errors as { weight: number }).weight;
    const total = (perf as { weight: number }).weight + (errors as { weight: number }).weight;
    expect(row.score).toBeCloseTo(weighted / total, 6);
  });

  it("honours a weights override", () => {
    const inputs = {
      perf_stability: levelInput([51], [50, 51, 49, 50, 51, 49, 50]),
      error_rate: rateInput(
        [[2], [100]],
        [
          [2, 2, 2],
          [100, 100, 100],
        ],
      ),
    };
    const base = { scene: "lobby", since: 0, until: 7 * 86_400_000, sampleSize: 120, inputs };
    // Zero the perf weight and only the error factor remains.
    const row = computeSceneHealth({ ...base, weights: { perf_stability: 0 } });
    expect(row.score).toBe(50);
    expect(row.factors.find((entry) => entry.id === "perf_stability")?.weight).toBe(0);
  });

  it("scores null when nothing could be measured", () => {
    const row = computeSceneHealth({
      scene: "empty",
      since: 0,
      until: 7 * 86_400_000,
      sampleSize: 0,
      inputs: {},
    });
    expect(row.score).toBeNull();
    expect(row.factors).toHaveLength(HEALTH_FACTORS.length);
    expect(row.sampleSize).toBe(0);
  });

  it("drops baseline buckets with a zero denominator instead of reading them as 0", () => {
    // A day with no sessions has no error rate. Counting it as 0 would drag the
    // baseline median down and make every scene look bad.
    const row = computeSceneHealth({
      scene: "lobby",
      since: 0,
      until: 86_400_000,
      sampleSize: 10,
      inputs: {
        error_rate: rateInput(
          [[1], [10]],
          [
            [1, 1, 1],
            [10, 0, 10],
          ],
        ),
      },
    });
    const factor = row.factors.find((entry) => entry.id === "error_rate");
    expect(factor?.baseline).toBe(0.1);
    expect(factor?.score).toBe(50);
  });
});

describe("rankSceneHealth", () => {
  const row = (scene: string, score: number | null) => ({
    scene,
    score,
    factors: [],
    sampleSize: 0,
    since: 0,
    until: 0,
  });

  it("puts the least healthy scene first and unscored scenes last", () => {
    const ranked = rankSceneHealth([
      row("gallery", 80),
      row("void", null),
      row("lobby", 12),
      row("atrium", 44),
    ]);
    expect(ranked.map((entry) => entry.scene)).toEqual(["lobby", "atrium", "gallery", "void"]);
  });

  it("breaks ties by scene id, so the order is a function of the rows", () => {
    const ranked = rankSceneHealth([row("b", 50), row("a", 50)]);
    expect(ranked.map((entry) => entry.scene)).toEqual(["a", "b"]);
  });
});
