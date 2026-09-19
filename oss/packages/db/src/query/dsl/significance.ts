/**
 * **Is this change real?** — the two significance tests `compare` can justify
 * (ADR 0051 §4, design sketch §C.2).
 *
 * Pure functions over numbers: no registry, no store, no I/O. They exist here
 * rather than inline in `compare.ts` so they can be unit-tested against
 * textbook worked examples, which is the only way to be sure a statistic is
 * right — a plausible-looking number is exactly the failure mode this file is
 * meant to prevent, since a model will quote whatever it is handed.
 *
 * Two tests, because analytics produces two shapes of measure:
 *
 * - {@link twoProportionZ} — a **count or rate**. "Was 40/1000 this week
 *   different from 25/900 last week?" Pooled two-proportion z, two-sided normal
 *   p-value, plus a Wilson score interval on each proportion (which, unlike the
 *   Wald interval, stays inside 0..1 at the small counts a long tail produces —
 *   the same reason the summariser already uses it).
 * - {@link welchT} — a **mean** over two samples of unequal size and variance.
 *   Welch's unequal-variance t-test with the Welch–Satterthwaite degrees of
 *   freedom. It applies where the two ranges really do give two *samples*: a
 *   `bucket`-grain metric compared range-over-range hands us one value per
 *   bucket on each side.
 *
 * Neither is applied speculatively. `compare.ts` computes a significance only
 * when the registry says the measure supports it (`unit: count | sessions`, or a
 * `rateOf` denominator) and the denominator clears the metric's
 * `comparable.minSample`; otherwise the field is simply absent, because
 * "no p-value" is a far better answer than a p-value computed from a
 * denominator that cannot support one.
 *
 * ## Accuracy
 *
 * The normal CDF uses the Abramowitz & Stegun 7.1.26 rational approximation of
 * `erf` (|error| < 1.5e-7). The Student-t CDF uses the regularised incomplete
 * beta function via the Lentz continued fraction (Numerical Recipes §6.4),
 * converged to 3e-16 or 300 iterations. Both are far tighter than the third
 * significant figure anyone reads off a p-value.
 */

/** A 95% (by default) score interval on a proportion. */
export interface ScoreInterval {
  low: number;
  high: number;
}

/** One side of a proportion comparison. */
export interface Proportion {
  /** Events (or sessions) in this group. */
  successes: number;
  /** Events (or sessions) in the population the group is part of. */
  trials: number;
}

/** The result of a two-proportion z test. */
export interface ProportionSignificance {
  test: "two-proportion-z";
  /** Share of the current population. */
  current: number;
  /** Share of the previous population. */
  previous: number;
  /** `current - previous`, in share points. */
  diff: number;
  /** The test statistic. */
  z: number;
  /** Two-sided p-value under the normal approximation. */
  pValue: number;
  /** Whether `pValue` clears the level the caller asked for. */
  significant: boolean;
  /** 95% Wilson score interval on the current share. */
  currentInterval: ScoreInterval;
  /** 95% Wilson score interval on the previous share. */
  previousInterval: ScoreInterval;
}

/** The result of Welch's unequal-variance t test. */
export interface MeanSignificance {
  test: "welch-t";
  current: number;
  previous: number;
  diff: number;
  /** The test statistic. */
  t: number;
  /** Welch–Satterthwaite degrees of freedom. */
  df: number;
  pValue: number;
  significant: boolean;
  /** Samples behind each mean — a t-test on two points is not evidence. */
  currentSamples: number;
  previousSamples: number;
}

/** Either shape of significance a comparison row can carry. */
export type Significance = ProportionSignificance | MeanSignificance;

/** The default two-sided level. */
export const DEFAULT_ALPHA = 0.05;

/** z for a 95% two-sided interval. */
const Z_95 = 1.959963984540054;

/**
 * `erf(x)` — Abramowitz & Stegun 7.1.26. |error| < 1.5e-7, which is three
 * orders of magnitude finer than any p-value is read to.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-z * z));
}

/** The standard normal CDF, Φ(x). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** `ln Γ(x)` — Lanczos approximation (g = 7, n = 9); exact to ~15 digits for x > 0. */
function logGamma(x: number): number {
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection, so the series stays in its convergent range.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let series = coefficients[0] as number;
  for (let i = 1; i < coefficients.length; i++) series += (coefficients[i] as number) / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Continued fraction for the incomplete beta function (Numerical Recipes §6.4). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-16) break;
  }
  return h;
}

/** The regularised incomplete beta function `I_x(a, b)`. */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** The two-sided p-value of a Student-t statistic with `df` degrees of freedom. */
export function studentTTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

/**
 * A Wilson score interval on `successes / trials`.
 *
 * The same interval the summary envelope reports, restated here so this module
 * stays free of the summariser (and vice versa): both need it, neither should
 * import the other.
 */
export function wilsonScoreInterval(
  successes: number,
  trials: number,
  z: number = Z_95,
): ScoreInterval {
  if (trials <= 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return {
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  };
}

/**
 * Pooled two-proportion z test: is `current.successes / current.trials`
 * different from `previous.successes / previous.trials`?
 *
 * Returns `null` when either side has no trials — a proportion of nothing is not
 * a proportion, and reporting `z = 0` for it would read as "no change" when the
 * truth is "no data".
 */
export function twoProportionZ(
  current: Proportion,
  previous: Proportion,
  alpha: number = DEFAULT_ALPHA,
): ProportionSignificance | null {
  if (current.trials <= 0 || previous.trials <= 0) return null;
  const p1 = current.successes / current.trials;
  const p2 = previous.successes / previous.trials;
  const pooled = (current.successes + previous.successes) / (current.trials + previous.trials);
  const standardError = Math.sqrt(
    pooled * (1 - pooled) * (1 / current.trials + 1 / previous.trials),
  );
  // Two identical proportions at 0 or 1 give a zero standard error; the honest
  // statistic there is z = 0 (no evidence of a difference), not a division by
  // zero that would surface as NaN and be rendered as "null" downstream.
  const z = standardError === 0 ? 0 : (p1 - p2) / standardError;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return {
    test: "two-proportion-z",
    current: p1,
    previous: p2,
    diff: p1 - p2,
    z,
    pValue,
    significant: pValue < alpha,
    currentInterval: wilsonScoreInterval(current.successes, current.trials),
    previousInterval: wilsonScoreInterval(previous.successes, previous.trials),
  };
}

/** One sample, described by the three numbers Welch's test needs. */
export interface Sample {
  mean: number;
  /** Unbiased (n − 1) sample variance. */
  variance: number;
  /** Number of observations. */
  n: number;
}

/** Mean and unbiased variance of a list of observations; `null` below two. */
export function sampleOf(values: readonly number[]): Sample | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance =
    finite.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / (finite.length - 1);
  return { mean, variance, n: finite.length };
}

/**
 * Welch's unequal-variance t test with the Welch–Satterthwaite degrees of
 * freedom.
 *
 * Returns `null` when either sample has fewer than two observations (there is no
 * variance to test) or when both variances are zero and the means are equal.
 */
export function welchT(
  current: Sample,
  previous: Sample,
  alpha: number = DEFAULT_ALPHA,
): MeanSignificance | null {
  if (current.n < 2 || previous.n < 2) return null;
  const sc = current.variance / current.n;
  const sp = previous.variance / previous.n;
  const denominator = Math.sqrt(sc + sp);
  if (denominator === 0) return null;
  const t = (current.mean - previous.mean) / denominator;
  const df = ((sc + sp) * (sc + sp)) / ((sc * sc) / (current.n - 1) + (sp * sp) / (previous.n - 1));
  const pValue = studentTTwoSided(t, df);
  return {
    test: "welch-t",
    current: current.mean,
    previous: previous.mean,
    diff: current.mean - previous.mean,
    t,
    df,
    pValue,
    significant: pValue < alpha,
    currentSamples: current.n,
    previousSamples: previous.n,
  };
}
