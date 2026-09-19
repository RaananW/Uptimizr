/**
 * `insight_significance` (#307) — the statistics, pinned against **published
 * reference values** rather than against themselves.
 *
 * Every test below states where its expected number comes from, and every one
 * of them is reproducible outside this repository:
 *
 * - **Welch's t** — the two-sample example from the Wikipedia article on
 *   Welch's t-test (`A1` vs `A2`, 15 observations each), which R's
 *   `t.test(A1, A2)` reports as `t = -2.4554, df = 24.989, p-value = 0.02138`.
 *   The means and unbiased variances behind it are hand-checkable:
 *   20.82 / 22.986667 and 7.867429 / 3.812667.
 * - **Two-proportion z** — 15/100 versus 25/100, chosen because every step is
 *   checkable by hand: pooled p = 0.2, SE = sqrt(0.16 * 0.02) = 0.0565685,
 *   z = -0.10 / 0.0565685 = -1.767767, two-sided p = 0.077100.
 * - **Wilson interval** — the textbook boundary case, 0 successes in 10 trials:
 *   (0, 0.27753). Agresti & Coull (1998) quote the same number.
 * - **Poisson rate test** — R's `poisson.test(c(10, 20), c(1, 1))`:
 *   p = 0.09873714, which is `2 * pbinom(10, 30, 0.5)` exactly.
 * - **Student-t critical values** — the two everyone knows: t(0.975, 10) =
 *   2.228, t(0.975, 30) = 2.042.
 *
 * The special functions are asserted directly as well, because a p-value that
 * is wrong in the fourth digit is worse than one that is obviously broken.
 */

import { describe, expect, it } from "vitest";
import {
  binomialCdf,
  computeSignificance,
  newcombeDifferenceInterval,
  normalCdf,
  normalTwoSidedP,
  poissonRateTest,
  regularizedIncompleteBeta,
  studentTCritical,
  studentTwoSidedP,
  twoProportionTest,
  welchTest,
  wilsonBounds,
  type MetricBucketRow,
} from "../index.js";

/** Bucket rows from a bare list of values, one per day. */
function series(values: readonly (number | null)[], sample = 100): MetricBucketRow[] {
  return values.map((value, index) => ({
    bucket: index * 86_400_000,
    value,
    sample_size: sample,
  }));
}

describe("special functions", () => {
  it("computes the standard normal CDF at the values every table lists", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 15);
    expect(normalCdf(1)).toBeCloseTo(0.8413447460685429, 14);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 14);
    expect(normalCdf(-2.5758293035489004)).toBeCloseTo(0.005, 14);
    // Symmetry has to hold exactly, or a two-sided p-value depends on the sign
    // of the effect.
    expect(normalCdf(-1.3) + normalCdf(1.3)).toBeCloseTo(1, 14);
  });

  it("computes the regularized incomplete beta against its closed forms", () => {
    // I_x(1, 1) = x, exactly.
    expect(regularizedIncompleteBeta(1, 1, 0.37)).toBeCloseTo(0.37, 10);
    // I_x(2, 1) = x^2 and I_x(1, 2) = 1 - (1 - x)^2.
    expect(regularizedIncompleteBeta(2, 1, 0.5)).toBeCloseTo(0.25, 10);
    expect(regularizedIncompleteBeta(1, 2, 0.5)).toBeCloseTo(0.75, 10);
    // Symmetry: I_x(a, b) = 1 - I_(1-x)(b, a).
    expect(regularizedIncompleteBeta(3.5, 2.5, 0.4)).toBeCloseTo(
      1 - regularizedIncompleteBeta(2.5, 3.5, 0.6),
      10,
    );
  });

  it("turns a z into the two-sided p-value the tables give", () => {
    // z = 1.96 is the 5% two-sided critical value, by definition.
    expect(normalTwoSidedP(1.959963984540054)).toBeCloseTo(0.05, 12);
    expect(normalTwoSidedP(0)).toBe(1);
    // Sign cannot matter for a two-sided test.
    expect(normalTwoSidedP(-2.5)).toBeCloseTo(normalTwoSidedP(2.5), 15);
    expect(normalTwoSidedP(2.5)).toBeCloseTo(0.012419, 6);
  });

  it("turns a t into the two-sided p-value the tables give", () => {
    // t(0.975, 10) = 2.228 -> p = 0.05; t = 0 -> p = 1.
    expect(studentTwoSidedP(2.228138852, 10)).toBeCloseTo(0.05, 8);
    expect(studentTwoSidedP(0, 10)).toBe(1);
    // With many degrees of freedom the t converges on the normal.
    expect(studentTwoSidedP(1.959963984540054, 1e6)).toBeCloseTo(0.05, 5);
  });

  it("reproduces the Student-t critical values from the tables", () => {
    expect(studentTCritical(10)).toBeCloseTo(2.228, 3);
    expect(studentTCritical(30)).toBeCloseTo(2.042, 3);
    // As df grows, t converges on the normal's 1.96.
    expect(studentTCritical(100000)).toBeCloseTo(1.95996, 4);
  });

  it("computes binomial tails against hand-summed values", () => {
    // P(X <= 10) for X ~ Binom(30, 0.5) = 0.049368572.
    expect(binomialCdf(10, 30, 0.5)).toBeCloseTo(0.04936857, 8);
    // P(X <= 0) for X ~ Binom(5, 0.5) = 1/32.
    expect(binomialCdf(0, 5, 0.5)).toBeCloseTo(0.03125, 10);
    expect(binomialCdf(5, 5, 0.5)).toBe(1);
    expect(binomialCdf(-1, 5, 0.5)).toBe(0);
  });
});

describe("Wilson and Newcombe intervals", () => {
  it("gives the textbook interval for 0 of 10 — never a zero-width one", () => {
    const [lo, hi] = wilsonBounds(0, 10);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.27753, 5);
  });

  it("is symmetric about 0.5 and centred there for 5 of 10", () => {
    const [lo, hi] = wilsonBounds(5, 10);
    expect((lo + hi) / 2).toBeCloseTo(0.5, 10);
    expect(lo).toBeCloseTo(0.2366, 4);
    expect(hi).toBeCloseTo(0.7634, 4);
  });

  it("never leaves [0, 1], even at the boundaries", () => {
    for (const [x, n] of [
      [0, 3],
      [3, 3],
      [1, 1],
      [0, 1],
    ] as const) {
      const [lo, hi] = wilsonBounds(x, n);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(1);
      expect(hi).toBeGreaterThan(lo);
    }
  });

  it("brackets the observed difference with a Newcombe interval", () => {
    const [lo, hi] = newcombeDifferenceInterval(15, 100, 25, 100);
    const observed = 0.15 - 0.25;
    expect(lo).toBeLessThan(observed);
    expect(hi).toBeGreaterThan(observed);
    // The interval excludes 0 only just — consistent with p just under 0.08
    // being borderline. Both bounds stay inside [-1, 1].
    expect(lo).toBeGreaterThan(-1);
    expect(hi).toBeLessThan(1);
    expect(hi).toBeGreaterThan(0);
  });
});

describe("two-proportion z-test", () => {
  it("matches the hand-computed 15/100 vs 25/100", () => {
    const result = twoProportionTest(15, 100, 25, 100);
    // pooled 0.2; SE = sqrt(0.2 * 0.8 * 0.02) = 0.05656854; z = -1.767767.
    expect(result.effect).toBeCloseTo(-0.1, 12);
    expect(result.p).toBeCloseTo(0.0771, 4);
  });

  it("reports p = 1 when neither arm saw a single success", () => {
    const result = twoProportionTest(0, 50, 0, 50);
    expect(result.effect).toBe(0);
    expect(result.p).toBe(1);
  });

  it("has no answer without trials on both sides", () => {
    expect(twoProportionTest(3, 0, 5, 10).p).toBeNull();
    expect(twoProportionTest(3, 10, 5, 0).effect).toBeNull();
  });
});

describe("Welch's t-test", () => {
  // The standard worked example (Wikipedia, "Welch's t-test"; identical to R's
  // t.test with var.equal = FALSE).
  const A1 = [
    27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4,
  ];
  const A2 = [
    27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 20.5, 24.4,
  ];

  it("reproduces t = -2.4554 on df = 24.989, p = 0.02138", () => {
    const result = welchTest(A1, A2);
    expect(result.effect).toBeCloseTo(20.82 - 22.986667, 5);
    const t = (result.effect as number) / (result.se as number);
    // The figures R prints, to the precision it prints them at…
    expect(t).toBeCloseTo(-2.4554, 4);
    expect(result.df).toBeCloseTo(24.989, 3);
    expect(result.p).toBeCloseTo(0.02138, 5);
    expect(result.p).toBeCloseTo(0.0213780014628, 10);
    // …and to more, so a regression in the incomplete beta shows up as a
    // failure rather than as a rounding coincidence.
    expect(t).toBeCloseTo(-2.45535639828601, 10);
    expect(result.df).toBeCloseTo(24.98852929023142, 10);
  });

  it("puts the interval around the effect and excludes 0 when p < 0.05", () => {
    const result = welchTest(A1, A2);
    const [lo, hi] = result.ci95;
    expect(lo).not.toBeNull();
    expect(hi as number).toBeLessThan(0);
    expect(lo as number).toBeLessThan(result.effect as number);
  });

  it("has no p-value under two points a side", () => {
    expect(welchTest([1], [2, 3]).p).toBeNull();
    expect(welchTest([], []).effect).toBeNull();
  });

  it("reports p = 1 for two identical constant samples", () => {
    const result = welchTest([5, 5, 5], [5, 5, 5]);
    expect(result.effect).toBe(0);
    expect(result.p).toBe(1);
  });
});

describe("Poisson rate test", () => {
  it("matches R's poisson.test(c(10, 20), c(1, 1)) — p = 0.09873714", () => {
    const result = poissonRateTest(10, 1, 20, 1);
    expect(result.p).toBeCloseTo(0.0987371, 7);
    expect(result.effect).toBe(-10);
  });

  it("is exact at small counts, where a normal approximation is not", () => {
    // poisson.test(c(1, 8), c(1, 1)) — p = 2 * pbinom(1, 9, 0.5) = 0.0390625.
    expect(poissonRateTest(1, 1, 8, 1).p).toBeCloseTo(0.0390625, 7);
  });

  it("accounts for unequal exposure", () => {
    // Same counts, twice the exposure on one side: the rates now differ by 4x
    // rather than 2x, and the test is correspondingly more certain.
    const equal = poissonRateTest(20, 2, 20, 2);
    const unequal = poissonRateTest(20, 1, 20, 4);
    expect(equal.p).toBe(1);
    expect(unequal.p as number).toBeLessThan(0.001);
  });

  it("calls two empty windows identical rather than unknown", () => {
    const result = poissonRateTest(0, 7, 0, 7);
    expect(result.p).toBe(1);
    expect(result.effect).toBe(0);
  });
});

describe("computeSignificance — picking the test from the measure", () => {
  it("runs a two-proportion z when the metric declares a denominator", () => {
    const row = computeSignificance({
      metric: "dead_clicks",
      scene: "lobby",
      counting: true,
      unit: "clicks",
      current: series([15]),
      reference: series([25]),
      denominator: { current: series([100]), reference: series([100]) },
    });
    expect(row.test).toBe("two_proportion_z");
    expect(row.a).toEqual({ value: 0.15, n: 100 });
    expect(row.b).toEqual({ value: 0.25, n: 100 });
    expect(row.effect).toBeCloseTo(-0.1, 6);
    expect(row.p).toBeCloseTo(0.0771, 4);
    expect(row.effectUnit).toBe("ratio");
    expect(row.significant).toBe(false);
    expect(row.powerNote).toContain("80% power");
  });

  it("runs a Poisson rate test on a bare count, exposure = buckets", () => {
    const row = computeSignificance({
      metric: "error_heatmap",
      counting: true,
      unit: "errors",
      current: series([10]),
      reference: series([20]),
    });
    expect(row.test).toBe("poisson_rate");
    // `n` is the exposure (buckets), so `value * n` is the count on both sides.
    expect(row.a).toEqual({ value: 10, n: 1 });
    expect(row.b).toEqual({ value: 20, n: 1 });
    // Rounded to the API’s declared six decimals on the way out.
    expect(row.p).toBe(0.098737);
    expect(row.effectUnit).toBe("errors per bucket");
  });

  it("runs Welch's t on a level, over the bucket values", () => {
    const row = computeSignificance({
      metric: "perf_summary",
      counting: false,
      unit: "FPS",
      current: series([34, 33, 35, 34, 36, 33, 35]),
      reference: series([58, 59, 57, 58, 60, 58, 57]),
    });
    expect(row.test).toBe("welch_t");
    expect(row.a.n).toBe(7);
    expect(row.a.value).toBeCloseTo(34.285714, 5);
    expect(row.b.value).toBeCloseTo(58.142857, 5);
    expect(row.effect).toBeCloseTo(-23.857143, 5);
    expect(row.p as number).toBeLessThan(1e-9);
    expect(row.significant).toBe(true);
    expect(row.ci95[0] as number).toBeLessThan(row.effect as number);
    expect(row.ci95[1] as number).toBeLessThan(0);
  });

  it("warns when a Welch comparison has too few buckets to say anything", () => {
    const row = computeSignificance({
      metric: "perf_summary",
      counting: false,
      unit: "FPS",
      current: series([40, 42]),
      reference: series([58, 57]),
    });
    expect(row.powerNote).toContain("buckets are being compared");
  });

  it("warns when a count series is too overdispersed for the Poisson model", () => {
    const row = computeSignificance({
      metric: "error_heatmap",
      counting: true,
      unit: "errors",
      current: series([0, 0, 0, 200, 0, 0, 1]),
      reference: series([3, 4, 3, 4, 3, 4, 3]),
    });
    expect(row.powerNote).toContain("vary far more than a Poisson process would");
  });

  it("skips null buckets rather than reading them as zero", () => {
    const row = computeSignificance({
      metric: "perf_summary",
      counting: false,
      unit: "FPS",
      current: series([50, null, 50, null, 50]),
      reference: series([50, 50, 50]),
    });
    expect(row.a.n).toBe(3);
    expect(row.effect).toBe(0);
  });

  it("says a constant comparison is constant, not under-powered", () => {
    const row = computeSignificance({
      metric: "perf_summary",
      counting: false,
      unit: "FPS",
      current: series([26, 26, 26, 26, 26, 26, 26]),
      reference: series([59, 59, 59, 59, 59, 59, 59]),
    });
    expect(row.effect).toBe(-33);
    expect(row.p).toBeNull();
    expect(row.powerNote).toContain("perfectly constant");
    expect(row.powerNote).not.toContain("not enough data");
  });

  it("reports an empty window as unknown, never as zero", () => {
    const row = computeSignificance({
      metric: "perf_summary",
      counting: false,
      unit: "FPS",
      current: series([]),
      reference: series([58, 59, 57]),
    });
    expect(row.a.value).toBeNull();
    expect(row.effect).toBeNull();
    expect(row.p).toBeNull();
    expect(row.significant).toBe(false);
  });
});
