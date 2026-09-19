/**
 * The two significance tests `compare` can justify (ADR 0051 §4, #304).
 *
 * Checked against **published values**, not against themselves: a statistic that
 * agrees with its own implementation proves nothing, and a plausible-looking
 * p-value is exactly the failure mode here — a model will quote whatever it is
 * handed. So the normal and Student-t tails are pinned to standard table
 * critical values, the Wilson intervals to the ones every textbook prints for
 * 0/10 and 50/100, and the two worked comparisons to arithmetic that can be
 * redone by hand from the numbers in the comment above each.
 */

import { describe, expect, it } from "vitest";
import {
  normalCdf,
  sampleOf,
  studentTTwoSided,
  twoProportionZ,
  welchT,
  wilsonScoreInterval,
} from "../query/dsl/significance.js";

describe("the normal tail", () => {
  it("matches the standard normal table", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 6);
    // The two critical values every interval in this codebase is built on.
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-2.575829)).toBeCloseTo(0.005, 6);
  });

  it("is symmetric", () => {
    for (const x of [0.25, 1, 2.5, 4]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 6);
    }
  });
});

describe("the Student-t tail", () => {
  it("matches the two-sided 5% critical values of the t table", () => {
    // t(0.025, df) for df = 1, 10, 20, 100 — the column every stats table opens
    // with. Each must come back at p = 0.05.
    expect(studentTTwoSided(12.706, 1)).toBeCloseTo(0.05, 4);
    expect(studentTTwoSided(2.228, 10)).toBeCloseTo(0.05, 4);
    expect(studentTTwoSided(2.086, 20)).toBeCloseTo(0.05, 4);
    expect(studentTTwoSided(1.984, 100)).toBeCloseTo(0.05, 3);
  });

  it("converges on the normal as the degrees of freedom grow", () => {
    expect(studentTTwoSided(1.959964, 1_000_000)).toBeCloseTo(0.05, 4);
  });

  it("is 1 at zero and refuses impossible degrees of freedom", () => {
    expect(studentTTwoSided(0, 10)).toBeCloseTo(1, 10);
    expect(studentTTwoSided(2, 0)).toBe(1);
    expect(studentTTwoSided(Number.NaN, 10)).toBe(1);
  });
});

describe("the Wilson score interval", () => {
  it("matches the values printed for the two textbook cases", () => {
    // 0/10 — the case the Wald interval gets wrong by producing [0, 0].
    const none = wilsonScoreInterval(0, 10);
    expect(none.low).toBeCloseTo(0, 6);
    expect(none.high).toBeCloseTo(0.27753, 4);

    // 50/100 — symmetric, and the one everyone quotes.
    const half = wilsonScoreInterval(50, 100);
    expect(half.low).toBeCloseTo(0.40383, 4);
    expect(half.high).toBeCloseTo(0.59617, 4);
  });

  it("never leaves 0..1, which is the whole reason it is used here", () => {
    for (const [successes, trials] of [
      [0, 3],
      [1, 3],
      [3, 3],
      [1, 1000],
      [999, 1000],
    ] as const) {
      const interval = wilsonScoreInterval(successes, trials);
      expect(interval.low).toBeGreaterThanOrEqual(0);
      expect(interval.high).toBeLessThanOrEqual(1);
      expect(interval.low).toBeLessThanOrEqual(interval.high);
    }
  });

  it("is the whole unit interval when there is nothing to go on", () => {
    expect(wilsonScoreInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("the two-proportion z test", () => {
  it("reproduces a worked example", () => {
    // 34/100 versus 22/100. Pooled p = 56/200 = 0.28, so
    // SE = sqrt(0.28 · 0.72 · (1/100 + 1/100)) = sqrt(0.004032) = 0.0634980,
    // z = 0.12 / 0.0634980 = 1.88982, two-sided p = 0.0588.
    const result = twoProportionZ({ successes: 34, trials: 100 }, { successes: 22, trials: 100 });
    expect(result).not.toBeNull();
    expect(result?.current).toBeCloseTo(0.34, 10);
    expect(result?.previous).toBeCloseTo(0.22, 10);
    expect(result?.diff).toBeCloseTo(0.12, 10);
    expect(result?.z).toBeCloseTo(1.88982, 4);
    expect(result?.pValue).toBeCloseTo(0.0588, 4);
    expect(result?.significant).toBe(false);
  });

  it("calls a large, well-powered difference significant", () => {
    const result = twoProportionZ(
      { successes: 400, trials: 1000 },
      { successes: 250, trials: 1000 },
    );
    expect(result?.significant).toBe(true);
    expect(result?.pValue).toBeLessThan(0.001);
  });

  it("carries a Wilson interval for each side", () => {
    const result = twoProportionZ({ successes: 50, trials: 100 }, { successes: 0, trials: 10 });
    expect(result?.currentInterval.low).toBeCloseTo(0.40383, 4);
    expect(result?.previousInterval.high).toBeCloseTo(0.27753, 4);
  });

  it("refuses a proportion of nothing rather than reporting no change", () => {
    expect(twoProportionZ({ successes: 0, trials: 0 }, { successes: 1, trials: 10 })).toBeNull();
    expect(twoProportionZ({ successes: 1, trials: 10 }, { successes: 0, trials: 0 })).toBeNull();
  });

  it("reports no evidence, rather than NaN, when both sides are identical extremes", () => {
    const result = twoProportionZ({ successes: 10, trials: 10 }, { successes: 5, trials: 5 });
    expect(result?.z).toBe(0);
    expect(result?.pValue).toBeCloseTo(1, 7);
    expect(result?.significant).toBe(false);
  });
});

describe("Welch's t test", () => {
  it("reproduces a worked example", () => {
    // A = [1,2,3,4,5]: mean 3, unbiased variance 2.5, n 5.
    // B = [2,4,6,8,10]: mean 6, unbiased variance 10, n 5.
    // sc = 0.5, sp = 2 → t = (3 − 6) / sqrt(2.5) = −1.8973666,
    // df = (0.5 + 2)² / (0.5²/4 + 2²/4) = 6.25 / 1.0625 = 5.8823529.
    const a = sampleOf([1, 2, 3, 4, 5]);
    const b = sampleOf([2, 4, 6, 8, 10]);
    expect(a).toEqual({ mean: 3, variance: 2.5, n: 5 });
    expect(b).toEqual({ mean: 6, variance: 10, n: 5 });

    const result = welchT(a!, b!);
    expect(result?.t).toBeCloseTo(-1.8973666, 6);
    expect(result?.df).toBeCloseTo(5.8823529, 6);
    expect(result?.diff).toBe(-3);
    // …and the tail that produces: p = 0.1075.
    expect(result?.pValue).toBeCloseTo(0.1075, 4);
    expect(result?.significant).toBe(false);
  });

  it("finds a difference that is there", () => {
    const a = sampleOf([100, 101, 99, 100, 100, 101, 99, 100]);
    const b = sampleOf([90, 91, 89, 90, 90, 91, 89, 90]);
    const result = welchT(a!, b!);
    expect(result?.diff).toBeCloseTo(10, 6);
    expect(result?.pValue).toBeLessThan(0.001);
    expect(result?.significant).toBe(true);
  });

  it("refuses a sample with no variance to test", () => {
    expect(sampleOf([1])).toBeNull();
    expect(sampleOf([])).toBeNull();
    const constant = sampleOf([5, 5, 5]);
    expect(welchT(constant!, constant!)).toBeNull();
  });

  it("ignores non-finite observations rather than poisoning the mean", () => {
    expect(sampleOf([1, 2, Number.NaN, 3])).toEqual(sampleOf([1, 2, 3]));
  });
});
