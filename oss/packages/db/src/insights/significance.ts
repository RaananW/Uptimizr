/**
 * **`significance`** — "is that difference real?" (ADR 0051 §4, sketch §D).
 *
 * `movers` ranks changes by how unusual they are; this answers the next
 * question, the one a robust z-score deliberately does not: *given how much
 * data is behind each side, could this difference have come from chance alone?*
 *
 * Pure TypeScript over the same bucket series as every other primitive — no
 * SQL, no dialect, no I/O — so DuckDB, ClickHouse, Postgres and SQL Server
 * cannot disagree about a p-value.
 *
 * ## One test per shape of measure, chosen from the catalog, never guessed
 *
 * The right test is a property of what the number *is*, and the registry plus
 * the bucket-measure catalog already say what it is. So the choice is derived,
 * not configured:
 *
 * | The measure is… | Test | Effect | Interval |
 * | --- | --- | --- | --- |
 * | a **rate** — its `comparable.primary` declares `rateOf` and the catalog declares the matching denominator series | two-proportion z (pooled) | difference of proportions | Newcombe hybrid score, built from the two **Wilson** intervals |
 * | a **count** of events with no denominator | Poisson rate test (exact conditional binomial) | difference in events per bucket | normal approximation on the rate difference |
 * | anything else — a level or a summed quantity (`fps`, `ms`, bytes) | Welch's t over the per-bucket values | difference of means | `effect ± t(1−α/2, ν) · SE` |
 *
 * Every special function below is implemented here rather than pulled in as a
 * dependency, for the same reason the statistics are not computed in SQL: a
 * self-hoster's p-value must not depend on a transitive package version. They
 * are the textbook algorithms (Lentz's continued fraction for the incomplete
 * beta, Lanczos for the log-gamma, Abramowitz & Stegun 7.1.26 for the error
 * function) and `src/__tests__/insightSignificance.test.ts` pins each one
 * against published reference values.
 *
 * ## What this deliberately does not do
 *
 * **Two windows, not two segments.** Sketch §D allows either. Comparing two
 * *segments* (`variant=red` vs `variant=blue`) needs the bucket series split by
 * a promoted dimension, which the catalog cannot express in v1 — that is the
 * `splitBy` work that arrives with `anomalies` (#306). A segment comparison is
 * therefore refused at the route with a message naming the window parameters,
 * rather than silently answered with the wrong contrast.
 */

// The Wilson interval a significance row is built from is the *same* one the
// `format=summary` envelope already puts on a share (design sketch §B.1), for
// the same reason `stats.ts` reuses `leastSquaresSlope`: two places in one API
// must not disagree about the interval around the same proportion. It is
// imported rather than re-exported — `@uptimizr/db` already exports it once.
import { Z_95, wilsonInterval } from "../query/summary/stats.js";
import type { MetricBucketRow } from "./buckets.js";
import { round } from "./stats.js";

// --- special functions ----------------------------------------------------

/** log Γ(x) for x > 0 — Lanczos approximation, g = 7, n = 9. */
function logGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection: Γ(x)Γ(1−x) = π / sin(πx).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = c[0] as number;
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += (c[i] as number) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * The continued fraction for the incomplete beta function (modified Lentz).
 * Converges for `x < (a+1)/(a+b+2)`; {@link regularizedIncompleteBeta} applies
 * the symmetry that guarantees it.
 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-16) break;
  }
  return h;
}

/** The regularized incomplete beta function `I_x(a, b)`. */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (!(x > 0)) return 0;
  if (!(x < 1)) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 -
        (Math.exp(
          logGamma(a + b) - logGamma(a) - logGamma(b) + b * Math.log(1 - x) + a * Math.log(x),
        ) *
          betaContinuedFraction(b, a, 1 - x)) /
          b;
}

/**
 * The standard normal CDF, Φ(z), to full double precision.
 *
 * Hart’s rational approximation as given by West, *Better Approximations to
 * Cumulative Normal Functions* (2005): a 6/7-degree rational for |z| < 7.07 and
 * a continued fraction beyond it. The familiar Abramowitz & Stegun 7.1.26
 * `erf` is not good enough here — its error is ~1.5e-7 *absolute*, which is
 * larger than the p-values this function is asked to produce.
 */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const x = Math.abs(z);
  let upper: number;
  if (x > 37) {
    upper = 0;
  } else {
    const e = Math.exp((-x * x) / 2);
    if (x < 7.07106781186547) {
      let numerator = 3.52624965998911e-2 * x + 0.700383064443688;
      numerator = numerator * x + 6.37396220353165;
      numerator = numerator * x + 33.912866078383;
      numerator = numerator * x + 112.079291497871;
      numerator = numerator * x + 221.213596169931;
      numerator = numerator * x + 220.206867912376;
      let denominator = 8.83883476483184e-2 * x + 1.75566716318264;
      denominator = denominator * x + 16.064177579207;
      denominator = denominator * x + 86.7807322029461;
      denominator = denominator * x + 296.564248779674;
      denominator = denominator * x + 637.333633378831;
      denominator = denominator * x + 793.826512519948;
      denominator = denominator * x + 440.413735824752;
      upper = (e * numerator) / denominator;
    } else {
      let fraction = x + 0.65;
      fraction = x + 4 / fraction;
      fraction = x + 3 / fraction;
      fraction = x + 2 / fraction;
      fraction = x + 1 / fraction;
      upper = e / fraction / 2.506628274631;
    }
  }
  return z > 0 ? 1 - upper : upper;
}

/** Two-sided p-value of a standard normal test statistic. */
export function normalTwoSidedP(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
}

/** Two-sided p-value of a Student-t statistic on `df` degrees of freedom. */
export function studentTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  return Math.min(1, regularizedIncompleteBeta(df / 2, 0.5, df / (df + t * t)));
}

/** The 1−α/2 quantile of Student's t on `df` degrees of freedom, by bisection. */
export function studentTCritical(df: number, alpha = 0.05): number {
  if (!Number.isFinite(df) || df <= 0) return Number.NaN;
  let low = 0;
  let high = 400;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (studentTwoSidedP(mid, df) > alpha) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** `P(X ≤ k)` for `X ~ Binomial(n, p)`, via the incomplete beta identity. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  return regularizedIncompleteBeta(n - k, k + 1, 1 - p);
}

/** The 80th percentile of the standard normal — the z for 80% power. */
export const Z_80 = 0.8416212335729143;

// --- Wilson and Newcombe intervals ---------------------------------------

/**
 * The shared Wilson interval as a plain pair, with the one behaviour this
 * module needs that the summariser’s does not: an answer even when the count
 * is not a proper proportion.
 *
 * `wilsonInterval` returns `null` for `successes > trials` because a share
 * summary must refuse to draw an interval on a number that is not a share. Here
 * that case is already reported to the caller in `powerNote`, so the widest
 * honest interval — the whole unit range — is the right fallback rather than a
 * missing row.
 */
export function wilsonBounds(successes: number, trials: number): [number, number] {
  const interval = wilsonInterval(successes, trials, Z_95);
  return interval == null ? [0, 1] : [interval.low, interval.high];
}

/**
 * **Newcombe's hybrid score interval** (1998, method 10) for the difference
 * between two independent proportions, built from the two Wilson intervals.
 *
 * The natural companion to a Wilson interval per arm: it inherits Wilson's
 * behaviour at the boundaries, so a comparison against a zero-count arm still
 * produces an interval of finite, honest width instead of collapsing.
 */
export function newcombeDifferenceInterval(
  successesA: number,
  trialsA: number,
  successesB: number,
  trialsB: number,
): [number, number] {
  const pa = trialsA > 0 ? successesA / trialsA : 0;
  const pb = trialsB > 0 ? successesB / trialsB : 0;
  const [la, ua] = wilsonBounds(successesA, trialsA);
  const [lb, ub] = wilsonBounds(successesB, trialsB);
  const difference = pa - pb;
  const lower = difference - Math.sqrt((pa - la) ** 2 + (ub - pb) ** 2);
  const upper = difference + Math.sqrt((ua - pa) ** 2 + (pb - lb) ** 2);
  return [Math.max(-1, lower), Math.min(1, upper)];
}

// --- the three tests ------------------------------------------------------

/** Which test produced a row. Also the `test` column's closed vocabulary. */
export type SignificanceTest = "two_proportion_z" | "welch_t" | "poisson_rate";

/**
 * One side of a comparison.
 *
 * `n` is always **the denominator `value` rests on** — trials for a
 * proportion, buckets for a rate or a mean — so `value * n` recovers the
 * total the arm was computed from whichever test ran. Keeping that invariant
 * across the three tests is what lets a reader check the arithmetic without
 * first working out which test produced the row.
 */
export interface SignificanceArm {
  /** The metric's value over this window, in its own unit (a proportion for a rate). */
  value: number | null;
  /** The denominator the value rests on: trials, or buckets. */
  n: number;
}

/** What `significance` reports. One row per request. */
export interface SignificanceRow {
  metric: string;
  /** The scene it was scoped to; `''` when the comparison spans every scene. */
  scene: string;
  /** The current window. */
  a: SignificanceArm;
  /** The reference window. */
  b: SignificanceArm;
  /** `a − b`, in the unit named by `effectUnit`. */
  effect: number | null;
  /** The 95% confidence interval for `effect`. */
  ci95: [number | null, number | null];
  /** Two-sided p-value for H₀: no difference. */
  p: number | null;
  test: SignificanceTest;
  /** What one unit of `effect` means — the difference is never unitless. */
  effectUnit: string;
  /** Whether `p` cleared α = 0.05. A convenience, never a substitute for the interval. */
  significant: boolean;
  /**
   * What these sample sizes can and cannot detect, in one sentence: the
   * smallest difference detectable at 80% power, and any assumption the data
   * strained on the way.
   */
  powerNote: string;
}

/** Decimals a significance number is rounded to before it leaves the API. */
export const SIGNIFICANCE_PRECISION = 6;

/** Conventional significance level. Fixed: a caller-tunable α is p-hacking with extra steps. */
export const SIGNIFICANCE_ALPHA = 0.05;

/** `z(1−α/2) + z(power)` — the multiplier in a minimum-detectable-effect. */
const MDE_MULTIPLIER = Z_95 + Z_80;

/** One sentence naming the smallest effect these sample sizes could have found. */
function mdeNote(standardError: number | null, unit: string, extra?: string): string {
  const head =
    standardError == null || !Number.isFinite(standardError) || standardError <= 0
      ? "There is not enough data on one side to say what this comparison could have detected."
      : `With these sample sizes the smallest difference detectable at 80% power (alpha 0.05) is ` +
        `about ${formatMagnitude(MDE_MULTIPLIER * standardError)} ${unit}; a smaller true ` +
        `difference would usually go unnoticed here.`;
  return extra == null ? head : `${head} ${extra}`;
}

/** A magnitude rendered with enough digits to be read, and no more. */
function formatMagnitude(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0";
  const decimals = magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : magnitude >= 0.01 ? 4 : 6;
  return String(Number(magnitude.toFixed(decimals)));
}

/**
 * **Two-proportion z-test**, pooled, with a Newcombe interval on the difference.
 *
 * `H₀: p_a = p_b`. The pooled proportion is used in the standard error because
 * that is the variance *under the null* — the hypothesis being tested — while
 * the interval is unpooled, because an interval describes the difference that
 * was actually observed. The two therefore answer slightly different questions
 * and can, in a borderline case, disagree about whether zero is excluded. That
 * is a property of the textbook procedure, not a bug, and the interval is the
 * one to believe.
 */
export function twoProportionTest(
  successesA: number,
  trialsA: number,
  successesB: number,
  trialsB: number,
): {
  effect: number | null;
  ci95: [number | null, number | null];
  p: number | null;
  se: number | null;
} {
  if (!(trialsA > 0) || !(trialsB > 0)) {
    return { effect: null, ci95: [null, null], p: null, se: null };
  }
  const pa = successesA / trialsA;
  const pb = successesB / trialsB;
  const pooled = (successesA + successesB) / (trialsA + trialsB);
  const seNull = Math.sqrt(pooled * (1 - pooled) * (1 / trialsA + 1 / trialsB));
  const seObserved = Math.sqrt((pa * (1 - pa)) / trialsA + (pb * (1 - pb)) / trialsB);
  const z = seNull > 0 ? (pa - pb) / seNull : 0;
  return {
    effect: pa - pb,
    ci95: newcombeDifferenceInterval(successesA, trialsA, successesB, trialsB),
    // A pooled proportion of exactly 0 or 1 means neither arm saw a single
    // success (or a single failure). Nothing distinguishes them, so p = 1.
    p: seNull > 0 ? normalTwoSidedP(z) : 1,
    se: seObserved,
  };
}

/** Mean and unbiased variance of a sample; `null` variance under two points. */
function moments(values: readonly number[]): { mean: number; variance: number | null; n: number } {
  const n = values.length;
  if (n === 0) return { mean: Number.NaN, variance: null, n: 0 };
  let total = 0;
  for (const value of values) total += value;
  const mean = total / n;
  if (n < 2) return { mean, variance: null, n };
  let sq = 0;
  for (const value of values) sq += (value - mean) ** 2;
  return { mean, variance: sq / (n - 1), n };
}

/**
 * **Welch's unequal-variances t-test** over two samples of per-bucket values.
 *
 * Welch rather than Student because the two windows are routinely of different
 * length *and* different volatility — a regressed week is both lower and more
 * erratic than the week before it — and pooling those variances would understate
 * the uncertainty exactly when it matters most.
 *
 * The samples are the **bucket values**, so `n` is the number of days (or
 * hours) compared, not the number of events behind them. That is the honest
 * unit: consecutive frame samples inside one day are anything but independent,
 * and treating them as `n` would produce a p-value of 1e-40 for a difference
 * any observer could see is within normal day-to-day drift.
 */
export function welchTest(
  sampleA: readonly number[],
  sampleB: readonly number[],
): {
  effect: number | null;
  ci95: [number | null, number | null];
  p: number | null;
  se: number | null;
  df: number | null;
} {
  const a = moments(sampleA);
  const b = moments(sampleB);
  if (a.n < 2 || b.n < 2 || a.variance == null || b.variance == null) {
    const effect = a.n > 0 && b.n > 0 ? a.mean - b.mean : null;
    return { effect, ci95: [null, null], p: null, se: null, df: null };
  }
  const va = a.variance / a.n;
  const vb = b.variance / b.n;
  const se = Math.sqrt(va + vb);
  const effect = a.mean - b.mean;
  if (!(se > 0)) {
    // Both samples are constant. They either agree exactly (no difference to
    // test) or differ by a fixed amount with zero observed variance, which no
    // t-test can attach a probability to.
    return { effect, ci95: [effect, effect], p: effect === 0 ? 1 : null, se: 0, df: null };
  }
  const df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1));
  const t = effect / se;
  const critical = studentTCritical(df, SIGNIFICANCE_ALPHA);
  return {
    effect,
    ci95: [effect - critical * se, effect + critical * se],
    p: studentTwoSidedP(t, df),
    se,
    df,
  };
}

/**
 * **Two-sample Poisson rate test** (Przyborowski & Wilks 1940).
 *
 * Conditional on the total `x_a + x_b`, the split between the two windows is
 * Binomial(total, t_a / (t_a + t_b)) under `H₀: λ_a = λ_b`, where `t` is each
 * window's exposure — here its number of buckets. That makes the exact p-value
 * a binomial tail, which is what this returns: exact whatever the counts, with
 * no normal approximation to fail at the small counts an error metric usually
 * has.
 *
 * The **interval**, by contrast, is the normal approximation on the rate
 * difference (`sqrt(x_a/t_a² + x_b/t_b²)`). There is no closed-form exact
 * interval for a difference of Poisson rates, and an approximate interval
 * reported as approximate is better than none; `powerNote` says so when the
 * counts are small enough for it to matter.
 */
export function poissonRateTest(
  countA: number,
  exposureA: number,
  countB: number,
  exposureB: number,
): {
  effect: number | null;
  ci95: [number | null, number | null];
  p: number | null;
  se: number | null;
} {
  if (!(exposureA > 0) || !(exposureB > 0)) {
    return { effect: null, ci95: [null, null], p: null, se: null };
  }
  const rateA = countA / exposureA;
  const rateB = countB / exposureB;
  const effect = rateA - rateB;
  const se = Math.sqrt(countA / exposureA ** 2 + countB / exposureB ** 2);
  const total = countA + countB;
  if (total <= 0) {
    // Neither window saw a single event. The rates are identical at zero, and
    // that is a real (if uninformative) answer rather than a missing one.
    return { effect: 0, ci95: [0, 0], p: 1, se: 0 };
  }
  const share = exposureA / (exposureA + exposureB);
  const expected = total * share;
  // Two-sided by doubling the smaller tail — the convention `poisson.test`
  // follows for equal exposures, and the only one that stays symmetric here.
  const p =
    countA <= expected
      ? Math.min(1, 2 * binomialCdf(countA, total, share))
      : Math.min(1, 2 * (1 - binomialCdf(countA - 1, total, share)));
  return { effect, ci95: [effect - Z_95 * se, effect + Z_95 * se], p, se };
}

// --- putting it together --------------------------------------------------

/** Everything `computeSignificance` needs about one comparison. */
export interface SignificanceInput {
  metric: string;
  scene?: string;
  /** `true` when the measure counts events (so a rate or a Poisson count). */
  counting: boolean;
  /** Buckets of the current window. */
  current: readonly MetricBucketRow[];
  /** Buckets of the reference window. */
  reference: readonly MetricBucketRow[];
  /**
   * The denominator series, when the metric is a declared rate: the same two
   * windows of its `rateOf` column. Absent for everything else.
   */
  denominator?: {
    current: readonly MetricBucketRow[];
    reference: readonly MetricBucketRow[];
  };
  /** What one unit of the metric is, for the `effectUnit` column. */
  unit: string;
}

/** The finite bucket values of a window, in bucket order. */
function valuesOf(rows: readonly MetricBucketRow[]): number[] {
  return [...rows]
    .sort((a, b) => a.bucket - b.bucket)
    .map((row) => row.value)
    .filter((value): value is number => value != null && Number.isFinite(value));
}

/** The sum of a window's bucket values; `0` over an empty window. */
function totalOf(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * Whether a count series is materially **overdispersed** — its bucket-to-bucket
 * variance far above its mean, which is exactly what a Poisson model assumes it
 * is not.
 *
 * Reported rather than corrected: an overdispersed count series makes the
 * Poisson p-value too small, and a reader who is told so can discount it. The
 * threshold is deliberately loose (variance more than three times the mean) so
 * that the note appears only when the assumption is clearly strained.
 */
function overdispersed(values: readonly number[]): boolean {
  const { mean, variance } = moments(values);
  return variance != null && mean > 0 && variance > 3 * mean;
}

/**
 * Compare one metric across two windows and say whether the difference is real.
 *
 * Pure: it takes the bucket series both windows produced (plus, for a rate, the
 * denominator's) and returns the row. No store, no request, no dialect.
 */
export function computeSignificance(input: SignificanceInput): SignificanceRow {
  const currentValues = valuesOf(input.current);
  const referenceValues = valuesOf(input.reference);
  const scene = input.scene ?? "";

  // --- a declared rate: two proportions ---
  if (input.denominator != null && input.counting) {
    const trialsA = totalOf(valuesOf(input.denominator.current));
    const trialsB = totalOf(valuesOf(input.denominator.reference));
    const successesA = totalOf(currentValues);
    const successesB = totalOf(referenceValues);
    const result = twoProportionTest(successesA, trialsA, successesB, trialsB);
    const clipped =
      successesA > trialsA || successesB > trialsB
        ? "One side counted more events than its denominator, so the ratio is not a proportion " +
          "and the interval should not be read as one."
        : undefined;
    return finish({
      metric: input.metric,
      scene,
      a: { value: trialsA > 0 ? successesA / trialsA : null, n: trialsA },
      b: { value: trialsB > 0 ? successesB / trialsB : null, n: trialsB },
      effect: result.effect,
      ci95: result.ci95,
      p: result.p,
      test: "two_proportion_z",
      effectUnit: "ratio",
      powerNote: mdeNote(result.se, "in the rate", clipped),
    });
  }

  // --- a bare count: a Poisson rate over buckets ---
  if (input.counting) {
    const exposureA = currentValues.length;
    const exposureB = referenceValues.length;
    const countA = totalOf(currentValues);
    const countB = totalOf(referenceValues);
    const result = poissonRateTest(countA, exposureA, countB, exposureB);
    const strained =
      overdispersed(currentValues) || overdispersed(referenceValues)
        ? "The bucket counts vary far more than a Poisson process would, so this p-value is " +
          "optimistic — treat it as an upper bound on the evidence, not a measurement of it."
        : undefined;
    return finish({
      metric: input.metric,
      scene,
      a: { value: exposureA > 0 ? countA / exposureA : null, n: exposureA },
      b: { value: exposureB > 0 ? countB / exposureB : null, n: exposureB },
      effect: result.effect,
      ci95: result.ci95,
      p: result.p,
      test: "poisson_rate",
      effectUnit: `${input.unit} per bucket`,
      powerNote: mdeNote(result.se, `${input.unit} per bucket`, strained),
    });
  }

  // --- a level or a summed quantity: Welch's t over the buckets ---
  const result = welchTest(currentValues, referenceValues);
  // Three different reasons a Welch row can be unconvincing, and they call for
  // three different sentences. Collapsing them into one would tell a reader
  // 'not enough data' about a window with a hundred identical buckets.
  const thin =
    result.se === 0 && currentValues.length >= 2 && referenceValues.length >= 2
      ? "Both windows are perfectly constant, so there is no observed variation to attach a " +
        "probability to. The effect is exact; the absence of a p-value is a statement about " +
        "the data, not about the difference."
      : currentValues.length < 5 || referenceValues.length < 5
        ? `Only ${currentValues.length} and ${referenceValues.length} buckets are being ` +
          "compared; a t-test on that few points has very little power, so a large p-value " +
          "here means 'not enough buckets', not 'no difference'."
        : undefined;
  return finish({
    metric: input.metric,
    scene,
    a: { value: bucketMean(currentValues), n: currentValues.length },
    b: { value: bucketMean(referenceValues), n: referenceValues.length },
    effect: result.effect,
    ci95: result.ci95,
    p: result.p,
    test: "welch_t",
    effectUnit: input.unit,
    // A zero standard error has nothing to say about detectable effects, and
    // `thin` already explains why — so it stands alone rather than being
    // prefixed with a sentence about missing data.
    powerNote: result.se === 0 && thin != null ? thin : mdeNote(result.se, input.unit, thin),
  });
}

/**
 * The window value Welch compares: the **mean of the bucket values**.
 *
 * Reported as a mean even for an additive measure, where `movers` would report
 * the window *sum*. A row whose `effect` is a difference of means must not
 * carry a `value` that is a sum, or the two numbers cannot be read together;
 * the caveat on the registry entry says so, and `n` is the bucket count so the
 * sum is one multiplication away.
 */
function bucketMean(values: readonly number[]): number | null {
  return values.length === 0 ? null : totalOf(values) / values.length;
}

/** Round every number in a row once, at the edge, and derive `significant`. */
function finish(row: Omit<SignificanceRow, "significant">): SignificanceRow {
  const p = round(row.p, SIGNIFICANCE_PRECISION);
  return {
    ...row,
    a: { value: round(row.a.value, SIGNIFICANCE_PRECISION), n: row.a.n },
    b: { value: round(row.b.value, SIGNIFICANCE_PRECISION), n: row.b.n },
    effect: round(row.effect, SIGNIFICANCE_PRECISION),
    ci95: [round(row.ci95[0], SIGNIFICANCE_PRECISION), round(row.ci95[1], SIGNIFICANCE_PRECISION)],
    p,
    significant: p != null && p < SIGNIFICANCE_ALPHA,
  };
}
