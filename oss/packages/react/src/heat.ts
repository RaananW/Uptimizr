// Shared heat-ramp used by the 3D viewers (Babylon needs float RGB) and their
// legends (CSS needs a matching gradient). Keeping both in one place means the
// swatch in the legend always matches the colors drawn in the scene.
//
// The ramp is the brand Ember heat ramp (docs/design/brand-guidelines.md):
// rust (cool/low) → ember (mid) → saffron (hot/high).

/** Map a normalized intensity [0,1] to a float RGB heat-ramp (rust → ember → saffron). */
export function heatRgb(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  // rust #b22f26, ember #e07b39, saffron #f4c84b (normalized to [0,1]).
  const rust = [0.698, 0.184, 0.149];
  const ember = [0.878, 0.482, 0.224];
  const saffron = [0.957, 0.784, 0.294];
  const lerp = (a: number[], b: number[], k: number): [number, number, number] => [
    a[0]! + (b[0]! - a[0]!) * k,
    a[1]! + (b[1]! - a[1]!) * k,
    a[2]! + (b[2]! - a[2]!) * k,
  ];
  return x < 0.5 ? lerp(rust, ember, x / 0.5) : lerp(ember, saffron, (x - 0.5) / 0.5);
}

/** A CSS `linear-gradient` matching {@link heatRgb} at t = 0, 0.5, 1 — for legends. */
export const HEAT_GRADIENT =
  "linear-gradient(to right, rgb(178,47,38), rgb(224,123,57), rgb(244,200,75))";

/**
 * Robust normalization denominator for a heatmap (ADR 0040 §2). Returns the value
 * at the `p`-quantile (default 0.95) of `counts` instead of the global maximum,
 * so a few hot outliers don't crush the contrast of the rest of the scene — the
 * problem that makes large scenes read as uniformly cold around one bright spot.
 *
 * The result is clamped to be at least 1 (so an all-zero/empty set never yields a
 * zero divisor) and never exceeds the true max. Linear interpolation between the
 * two nearest ranks keeps it stable for small samples.
 */
export function percentileMax(counts: readonly number[], p = 0.95): number {
  if (counts.length === 0) return 1;
  const sorted = [...counts].sort((a, b) => a - b);
  const clampedP = Math.max(0, Math.min(1, p));
  const rank = clampedP * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const value = lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
  return Math.max(1, value);
}
