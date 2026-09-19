/**
 * **`scene_health`** — "which scene is in trouble, and why?" (ADR 0051 §4, sketch §D).
 *
 * One number per scene, and — more importantly — the six numbers it was built
 * from. A single score is only useful if it can be taken apart: every factor
 * reports the **metric id** behind it, the **raw** value that metric produced,
 * the **normalised** 0–100 it contributed and the **weight** it carried, so
 * "the lobby is at 38" is always one step away from "because its 5th-percentile
 * FPS is 19 against a project norm of 47".
 *
 * Pure TypeScript over the same bucket series as every other primitive.
 *
 * ## The score is relative, and says so
 *
 * There is no absolute scale on which 60 FPS is "healthy" — a marketing
 * configurator and a six-player VR game do not share one — so every factor is
 * normalised against **the project's own baseline over the previous equal
 * window**, using the same robust centre-and-spread `movers` ranks with
 * (median, and a MAD floored at 1% of the level). A factor exactly at the
 * project norm scores **50**; {@link HEALTH_Z_SPAN} robust deviations better
 * scores 100, the same distance worse scores 0.
 *
 * That makes the score a comparison, not a grade: a project where every scene
 * is equally bad reads 50 across the board. It is the right shape for the
 * question actually asked ("*which* scene should I look at this week"), and the
 * registry entry's caveats say plainly that it is not a quality bar.
 *
 * ## Factors are declared, not inferred
 *
 * {@link HEALTH_FACTORS} is a fixed, ordered catalog. Each entry names the
 * metric it reads, whether it is a level or a rate (and which catalog series
 * supply the numerator and denominator), which direction is good, and its
 * default weight. Nothing here is derived from a request, so the fan-out is a
 * compile-time constant and a caller can only change the **weights** — never
 * which series are read.
 */

import type { MetricId } from "@uptimizr/metrics";
import type { MetricBucketRow } from "./buckets.js";
import { BUCKET_SECONDS, type BucketGrain, type BucketVariant } from "./measures.js";
import { referenceSpread } from "./movers.js";
import { median, round } from "./stats.js";
import { DAY_MS, floorToBucket, type ResolvedWindow } from "./windows.js";

/** How one health factor is measured. */
export interface HealthFactorSpec {
  /** Stable factor id — the key a `weights` override addresses it by. */
  readonly id: string;
  /** The registry metric this factor is a reading of. */
  readonly metric: MetricId;
  /**
   * The series that supplies the factor's numerator: a named catalog variant,
   * or `undefined` for the metric's own headline series.
   */
  readonly numerator?: BucketVariant;
  /**
   * The series that supplies the denominator, making this factor a **rate**.
   * `undefined` for a level factor (an FPS percentile), which is read directly.
   */
  readonly denominator?: BucketVariant;
  /** Whether a *higher* raw value is healthier. */
  readonly direction: "up" | "down";
  /** Default weight in the score. Overridable per request. */
  readonly weight: number;
  /** What one unit of the raw value is. */
  readonly unit: string;
  /** What the raw number actually measures — copied into the row. */
  readonly note: string;
}

/**
 * The six factors, in the order they are reported.
 *
 * The weights are a judgement, and they are declared here (and surfaced in the
 * registry entry, so they appear in `capabilities` and in the generated tool
 * catalog) precisely so that judgement is arguable rather than hidden: errors
 * and raw smoothness dominate, frustration signals matter, and exploration is a
 * tiebreak. A project that disagrees passes `weights`.
 */
export const HEALTH_FACTORS: readonly HealthFactorSpec[] = [
  {
    id: "perf_stability",
    metric: "perf_summary",
    numerator: "p05",
    direction: "up",
    weight: 0.25,
    unit: "FPS",
    note:
      "The 5th-percentile FPS of the scene's sampled frames — how bad it gets, not how good it " +
      "usually is. A scene whose median is fine and whose p05 is not is a stuttering scene.",
  },
  {
    id: "jank_rate",
    metric: "jank_rate",
    numerator: "numerator",
    denominator: "denominator",
    direction: "down",
    weight: 0.2,
    unit: "long frames per sampled window",
    note:
      "Long frames per sampled perf window, pooled across sessions. The metric's own endpoint " +
      "reports a per-session median instead, so the two agree in direction but not in value.",
  },
  {
    id: "error_rate",
    metric: "error_heatmap",
    denominator: "denominator",
    direction: "down",
    weight: 0.25,
    unit: "errors per session",
    note:
      "Runtime errors and engine diagnostics per session started. Divided by sessions because an " +
      "error count with no traffic behind it says nothing.",
  },
  {
    id: "dead_click_rate",
    metric: "dead_clicks",
    denominator: "denominator",
    direction: "down",
    weight: 0.15,
    unit: "share of clicks",
    note:
      "The share of clicks that hit no mesh at all — the 3D discoverability signal. Rage-click " +
      "bursts are not folded in: they are defined by the gap between consecutive clicks and have " +
      "no portable per-bucket form.",
  },
  {
    id: "coverage",
    metric: "scene_coverage",
    denominator: "denominator",
    direction: "up",
    weight: 0.1,
    unit: "camera samples per session",
    note:
      "Positioned camera samples per session — how much of the scene visitors actually move " +
      "through. A true voxel-coverage percentage needs the registered scene bounds and has no " +
      "portable per-bucket form, so this is the portable proxy, read only against the project's " +
      "own baseline.",
  },
  {
    id: "xr_abandonment",
    metric: "xr_abandonment",
    numerator: "numerator",
    denominator: "denominator",
    direction: "up",
    weight: 0.05,
    unit: "XR interactions per XR session",
    note:
      "Interactions per headset session. Absent (not zero) in a project with no XR traffic: a " +
      "scene nobody visited in VR is not an unhealthy VR scene.",
  },
];

/** Every factor id, for validating a `weights` override. */
export const HEALTH_FACTOR_IDS: readonly string[] = HEALTH_FACTORS.map((factor) => factor.id);

/** The declared default weights, as the registry entry publishes them. */
export const HEALTH_DEFAULT_WEIGHTS: Readonly<Record<string, number>> = Object.fromEntries(
  HEALTH_FACTORS.map((factor) => [factor.id, factor.weight]),
);

/**
 * How many robust deviations from the project norm span half the scale.
 *
 * At the norm a factor scores 50; `HEALTH_Z_SPAN` deviations better scores 100
 * and the same distance worse scores 0. Four is chosen so that the everyday
 * range of a metric occupies the middle of the scale rather than saturating it
 * — a scene one MAD off the norm reads 62 or 38, which is a nudge, and it takes
 * a genuinely unusual reading to bottom out.
 */
export const HEALTH_Z_SPAN = 4;

/** Decimals a health number is rounded to before it leaves the API. */
export const HEALTH_PRECISION = 6;

/**
 * Sessions below which a scene's score is not worth reading.
 *
 * Not a filter: the row is returned with its `sampleSize` so a caller can see
 * why, exactly as `movers` keeps its sub-`minSample` rows.
 */
export const HEALTH_MIN_SESSIONS = 20;

/** How many scenes one request may score when the caller names none. */
export const HEALTH_DEFAULT_SCENES = 5;

/** The hard cap on scenes per request — the fan-out is linear in this. */
export const HEALTH_MAX_SCENES = 10;

/** Default window, in days. */
export const HEALTH_DEFAULT_WINDOW_DAYS = 7;

/**
 * Resolve the window a health score is computed over, and the project baseline
 * window immediately before it.
 *
 * **This is the one insight primitive whose window includes the bucket in
 * progress**, and the difference is deliberate. `baseline` and `movers` floor
 * `until` down to the last complete bucket because they report *counts*, and a
 * third of a day of traffic compared against whole days reads as a collapse
 * every morning. Every health factor is a **rate or a percentile** — errors per
 * session, long frames per sampled window, the 5th-percentile FPS — and none of
 * those is distorted by a partial bucket: half a day of data gives half the
 * numerator *and* half the denominator.
 *
 * Flooring here would instead make the score answer about **yesterday**, which
 * is the wrong answer to 'which scene is in trouble' and, on a dashboard whose
 * range is the last hour, would show an empty tile all day.
 *
 * The baseline is the equal window immediately before — the same 'previous
 * equal window' reference `movers` uses, so a health score and a movers list
 * are read against the same past.
 */
export function resolveHealthWindows(opts: {
  since?: number;
  until?: number;
  windowDays?: number;
  bucket: BucketGrain;
  now: number;
}): { range: ResolvedWindow; baseline: ResolvedWindow } {
  const width = BUCKET_SECONDS[opts.bucket] * 1000;
  // Round `until` **up**, so the bucket the request lands in is whole.
  const until = Math.ceil((opts.until ?? opts.now) / width) * width;
  const days = opts.windowDays ?? HEALTH_DEFAULT_WINDOW_DAYS;
  const sinceRaw = floorToBucket(opts.since ?? until - days * DAY_MS, opts.bucket);
  const since = sinceRaw >= until ? until - width : sinceRaw;
  const span = until - since;
  return { range: { since, until }, baseline: { since: since - span, until: since } };
}

/** One factor's contribution to a scene's score. */
export interface HealthFactorRow {
  /** The factor id — the key a `weights` override addresses. */
  id: string;
  /** The registry metric behind the raw value. */
  metric: string;
  /** The value that metric produced over the window, in `unit`. */
  raw: number | null;
  /** The project baseline this was normalised against — the previous window's median. */
  baseline: number | null;
  /** 0–100 against that baseline; 50 is exactly the project norm. `null` when unavailable. */
  score: number | null;
  /** The weight this factor carried. */
  weight: number;
  unit: string;
  /** What the raw number is, and why it is normalised the way it is. */
  note: string;
}

/** What `scene_health` reports. One row per scene. */
export interface SceneHealthRow {
  /** The scene scored; `''` when the request spanned every scene. */
  scene: string;
  /** Weighted mean of the available factors' scores, 0–100; `null` when none were. */
  score: number | null;
  factors: HealthFactorRow[];
  /** Sessions behind the window — what decides whether the score means anything. */
  sampleSize: number;
  since: number;
  until: number;
}

/** The two bucket series one factor reads, over one window. */
export interface HealthSeries {
  numerator: readonly MetricBucketRow[];
  /** Absent for a level factor. */
  denominator?: readonly MetricBucketRow[];
}

/** Everything `computeSceneHealth` needs about one factor. */
export interface HealthFactorInput {
  /** The scene's series over the scored window. */
  current: HealthSeries;
  /** The project's series over the preceding equal window — the baseline. */
  baseline: HealthSeries;
}

/** The sum of a series' finite bucket values; `null` when it carried none. */
function total(rows: readonly MetricBucketRow[] | undefined): number | null {
  if (rows == null) return null;
  let sum = 0;
  let seen = 0;
  for (const row of rows) {
    if (row.value != null && Number.isFinite(row.value)) {
      sum += row.value;
      seen += 1;
    }
  }
  return seen === 0 ? null : sum;
}

/** The mean of a series' finite bucket values; `null` when it carried none. */
function levelOf(rows: readonly MetricBucketRow[] | undefined): number | null {
  if (rows == null) return null;
  const sum = total(rows);
  if (sum == null) return null;
  let seen = 0;
  for (const row of rows) if (row.value != null && Number.isFinite(row.value)) seen += 1;
  return seen === 0 ? null : sum / seen;
}

/**
 * The factor's value over a window.
 *
 * A rate is the **window ratio** — total numerator over total denominator, not
 * the mean of the per-bucket ratios. A day with three sessions and a day with
 * three hundred must not weigh the same in "errors per session", and averaging
 * the daily ratios is exactly the mistake that makes them.
 */
function windowValue(series: HealthSeries, spec: HealthFactorSpec): number | null {
  if (spec.denominator == null) return levelOf(series.numerator);
  const numerator = total(series.numerator) ?? 0;
  const denominator = total(series.denominator);
  if (denominator == null || denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * The per-bucket series the baseline's centre and spread are taken over.
 *
 * For a rate that is the bucket-by-bucket ratio, so the spread reflects how
 * much the *rate* normally moves rather than how much traffic does. Buckets
 * whose denominator is zero are dropped: a day with no sessions has no error
 * rate, and counting it as zero would drag every baseline down.
 */
function baselineSeries(series: HealthSeries, spec: HealthFactorSpec): number[] {
  if (spec.denominator == null) {
    return series.numerator
      .map((row) => row.value)
      .filter((value): value is number => value != null && Number.isFinite(value));
  }
  const numerators = new Map<number, number>();
  for (const row of series.numerator) {
    if (row.value != null && Number.isFinite(row.value)) numerators.set(row.bucket, row.value);
  }
  const out: number[] = [];
  for (const row of series.denominator ?? []) {
    if (row.value == null || !Number.isFinite(row.value) || row.value <= 0) continue;
    out.push((numerators.get(row.bucket) ?? 0) / row.value);
  }
  return out;
}

/**
 * Map a raw value onto 0–100 against a baseline centre and spread.
 *
 * Linear in the robust z and clamped, rather than a logistic or a percentile
 * rank: a reader has to be able to do the arithmetic backwards from the row.
 * `null` when the baseline carried nothing to compare against — an unscored
 * factor, never a default of 50, because "we have no history for this" and
 * "this is exactly normal" are different statements.
 */
export function normaliseFactor(
  raw: number | null,
  baseline: readonly number[],
  direction: "up" | "down",
): { score: number | null; centre: number | null } {
  const centre = median(baseline);
  if (raw == null || centre == null) return { score: null, centre };
  const spread = referenceSpread(baseline);
  if (spread == null || !(spread > 0)) {
    // A baseline with no spread at all (one bucket, or a perfectly flat one)
    // cannot say how unusual anything is. Equal to it is normal; anything else
    // is unquantifiable, so the factor reports the direction and nothing more.
    if (raw === centre) return { score: 50, centre };
    const better = direction === "up" ? raw > centre : raw < centre;
    return { score: better ? 100 : 0, centre };
  }
  const z = (raw - centre) / spread;
  const oriented = direction === "up" ? z : -z;
  const score = 50 + (50 * oriented) / HEALTH_Z_SPAN;
  return { score: Math.min(100, Math.max(0, score)), centre };
}

/**
 * Resolve the weights a request scores with.
 *
 * An override replaces a factor's weight; factors the override does not mention
 * keep their declared weight, so `weights={"error_rate":0.6}` means "I care
 * much more about errors" rather than "score errors only". Unknown ids are
 * rejected at the route, not silently ignored.
 */
export function resolveWeights(
  override?: Readonly<Record<string, number>> | null,
): Record<string, number> {
  const weights: Record<string, number> = { ...HEALTH_DEFAULT_WEIGHTS };
  for (const [id, value] of Object.entries(override ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(weights, id)) continue;
    if (Number.isFinite(value) && value >= 0) weights[id] = value;
  }
  return weights;
}

/**
 * Score one scene.
 *
 * `inputs` is keyed by factor id; a factor with no entry (a project with no XR
 * traffic, a scene with no perf samples) is reported with `score: null` and
 * excluded from the weighted mean rather than dropped from the row — the reason
 * a score is missing a factor has to be visible in the answer.
 */
export function computeSceneHealth(opts: {
  scene: string;
  since: number;
  until: number;
  sampleSize: number;
  inputs: Readonly<Record<string, HealthFactorInput | undefined>>;
  weights?: Readonly<Record<string, number>> | null;
}): SceneHealthRow {
  const weights = resolveWeights(opts.weights);
  const factors: HealthFactorRow[] = [];
  let weighted = 0;
  let weightTotal = 0;

  for (const spec of HEALTH_FACTORS) {
    const weight = weights[spec.id] ?? 0;
    const input = opts.inputs[spec.id];
    const raw = input == null ? null : windowValue(input.current, spec);
    const baseline = input == null ? [] : baselineSeries(input.baseline, spec);
    const { score, centre } = normaliseFactor(raw, baseline, spec.direction);
    if (score != null && weight > 0) {
      weighted += weight * score;
      weightTotal += weight;
    }
    factors.push({
      id: spec.id,
      metric: spec.metric,
      raw: round(raw, HEALTH_PRECISION),
      baseline: round(centre, HEALTH_PRECISION),
      score: round(score, HEALTH_PRECISION),
      weight,
      unit: spec.unit,
      note:
        score == null
          ? `${spec.note} Not scored: ${raw == null ? "the scene produced no value for it in this window" : "the project has no baseline for it in the preceding window"}.`
          : spec.note,
    });
  }

  return {
    scene: opts.scene,
    score: weightTotal > 0 ? round(weighted / weightTotal, HEALTH_PRECISION) : null,
    factors,
    sampleSize: opts.sampleSize,
    since: opts.since,
    until: opts.until,
  };
}

/** Least healthy first, then by scene id so the order is a function of the rows. */
export function rankSceneHealth(rows: readonly SceneHealthRow[]): SceneHealthRow[] {
  return [...rows].sort((a, b) => {
    const left = a.score ?? Number.POSITIVE_INFINITY;
    const right = b.score ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left - right;
    return a.scene < b.scene ? -1 : a.scene > b.scene ? 1 : 0;
  });
}
