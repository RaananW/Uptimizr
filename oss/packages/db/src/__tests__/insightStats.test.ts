/**
 * The insight statistics, on fixed series with hand-computed answers
 * (ADR 0051 §4, design sketch §D).
 *
 * These are the numbers `baseline` and `movers` are *made of*, so they are
 * pinned against arithmetic done by hand rather than against a snapshot of the
 * implementation: a test that only asserts "what it returns today" would let a
 * silent change of quantile definition or MAD scaling through.
 *
 * The recurring series is deliberately skewed — `[10, 12, 11, 13, 50]` — because
 * the whole reason these are robust statistics is that one outlier day must not
 * move the centre. Its mean (19.2) and its median (12) are nearly a factor of
 * two apart, which is exactly the regime a scene's real bucket series lives in.
 */

import { describe, expect, it } from "vitest";
import {
  MAD_TO_SIGMA,
  ROBUST_Z_EPSILON,
  leastSquaresSlope,
  mean,
  median,
  medianAbsoluteDeviation,
  quantile,
  relativeChange,
  robustZ,
  round,
  sum,
} from "../insights/stats.js";

/** Five buckets, one of them a spike. Every expectation below is hand-derived. */
const SKEWED = [10, 12, 11, 13, 50];

describe("insight statistics — centre and spread", () => {
  it("computes the mean of a fixed series", () => {
    // 10 + 12 + 11 + 13 + 50 = 96; 96 / 5 = 19.2
    expect(mean(SKEWED)).toBeCloseTo(19.2, 12);
    expect(mean([7])).toBe(7);
  });

  it("computes the median as the 0.5 quantile", () => {
    // sorted: 10, 11, 12, 13, 50 → middle is 12
    expect(median(SKEWED)).toBe(12);
    // Even length interpolates between the two middle order statistics.
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("interpolates quantiles between order statistics", () => {
    // sorted: 10, 11, 12, 13, 50. p10 sits at position 0.1*(5-1) = 0.4,
    // i.e. four tenths of the way from 10 to 11.
    expect(quantile(SKEWED, 0.1)).toBeCloseTo(10.4, 12);
    // p90 sits at position 3.6 — six tenths of the way from 13 to 50.
    expect(quantile(SKEWED, 0.9)).toBeCloseTo(35.2, 12);
    // The extremes are exact, never interpolated past the data.
    expect(quantile(SKEWED, 0)).toBe(10);
    expect(quantile(SKEWED, 1)).toBe(50);
  });

  it("computes the MAD as the median of absolute deviations", () => {
    // median 12 → deviations 2, 0, 1, 1, 38 → sorted 0, 1, 1, 2, 38 → median 1.
    // The 50 moves the MAD by nothing at all: that is the point of using it.
    expect(medianAbsoluteDeviation(SKEWED)).toBe(1);
    // A constant series has no spread — 0 is a fact about the data, not a gap.
    expect(medianAbsoluteDeviation([5, 5, 5])).toBe(0);
  });

  it("reports the MAD unscaled, leaving the sigma conversion to the caller", () => {
    // Normal-consistency scaling is a caller's choice, not baked into `mad`.
    expect(MAD_TO_SIGMA).toBeCloseTo(1.4826, 6);
    const mad = medianAbsoluteDeviation([1, 2, 3, 4, 5]);
    expect(mad).toBe(1);
    expect((mad as number) * MAD_TO_SIGMA).toBeCloseTo(1.4826, 6);
  });

  it("computes the least-squares slope against the bucket index", () => {
    // meanX = 2, meanY = 19.2. cov = 18.4 + 7.2 + 0 - 6.2 + 61.6 = 81;
    // var = 4 + 1 + 0 + 1 + 4 = 10 → slope 8.1 per bucket.
    expect(leastSquaresSlope(SKEWED)).toBeCloseTo(8.1, 12);
    // A flat series has slope 0; a perfectly linear one recovers its step.
    expect(leastSquaresSlope([4, 4, 4, 4])).toBe(0);
    expect(leastSquaresSlope([0, 3, 6, 9])).toBeCloseTo(3, 12);
  });

  it("sums a series, and reports nothing rather than zero for an empty one", () => {
    expect(sum(SKEWED)).toBe(96);
    expect(sum([])).toBeNull();
  });
});

describe("insight statistics — absence is not zero", () => {
  it("returns null for an empty series everywhere", () => {
    for (const fn of [mean, median, medianAbsoluteDeviation, leastSquaresSlope]) {
      expect(fn([]), fn.name).toBeNull();
    }
    expect(quantile([], 0.5)).toBeNull();
  });

  it("needs two points for a slope", () => {
    expect(leastSquaresSlope([42])).toBeNull();
    expect(leastSquaresSlope([42, 43])).toBeCloseTo(1, 12);
  });

  it("ignores non-finite values instead of poisoning the result with NaN", () => {
    expect(mean([1, Number.NaN, 3])).toBe(2);
    expect(median([1, Number.POSITIVE_INFINITY, 3])).toBe(2);
    expect(quantile([Number.NaN], 0.5)).toBeNull();
  });

  it("rejects a quantile outside 0..1", () => {
    expect(quantile(SKEWED, -0.1)).toBeNull();
    expect(quantile(SKEWED, 1.5)).toBeNull();
    expect(quantile(SKEWED, Number.NaN)).toBeNull();
  });
});

describe("insight statistics — robust z and relative change", () => {
  it("scores a change in units of the reference spread", () => {
    // A move of 10 against a series that normally swings by 2 is a 5-sigma-ish
    // event; the epsilon is far below the tolerance so it does not show.
    expect(robustZ(10, 2)).toBeCloseTo(5, 6);
    expect(robustZ(-3, 1.5)).toBeCloseTo(-2, 6);
  });

  it("scores no change as zero however flat the reference", () => {
    // Without this, 0 / (0 + ε) would still be 0 — but the intent is explicit:
    // nothing moved, so nothing is surprising.
    expect(robustZ(0, 0)).toBe(0);
    expect(robustZ(0, 12)).toBe(0);
  });

  it("stays finite against a reference that never varied", () => {
    const z = robustZ(1, 0);
    expect(z).not.toBeNull();
    expect(Number.isFinite(z as number)).toBe(true);
    // 1 / ε — a very large score, which is the honest reading: any change at all
    // is unprecedented for a series that has never moved.
    expect(z as number).toBeCloseTo(1 / ROBUST_Z_EPSILON, 0);
  });

  it("reports null when the change or the spread is unknown", () => {
    expect(robustZ(null, 2)).toBeNull();
    expect(robustZ(5, null)).toBeNull();
    expect(robustZ(5, -1)).toBeNull();
    expect(robustZ(Number.NaN, 2)).toBeNull();
  });

  it("computes relative change against the magnitude of the reference", () => {
    expect(relativeChange(12, 10)).toBeCloseTo(0.2, 12);
    expect(relativeChange(8, 10)).toBeCloseTo(-0.2, 12);
    // Against a negative reference the *direction* still follows the delta.
    expect(relativeChange(-8, -10)).toBeCloseTo(0.2, 12);
  });

  it("refuses a percentage change from zero", () => {
    // Infinity, or a made-up 100%, would both be claims the data cannot support.
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(null, 10)).toBeNull();
    expect(relativeChange(10, null)).toBeNull();
  });
});

describe("insight statistics — rounding at the edge", () => {
  it("rounds to a fixed precision so two engines cannot disagree in the last bits", () => {
    expect(round(1 / 3, 6)).toBe(0.333333);
    expect(round(3.0000000000000004, 6)).toBe(3);
    expect(round(-2.5000004, 6)).toBe(-2.5);
  });

  it("passes missing and non-finite values through as null", () => {
    expect(round(null)).toBeNull();
    expect(round(Number.NaN)).toBeNull();
    expect(round(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
