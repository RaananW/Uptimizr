import type { ColorRamp } from "./types.js";

/** Clamp a number into the inclusive `[0, 1]` range. */
export function clamp01(t: number): number {
  if (Number.isNaN(t)) return 0;
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/**
 * Default cold→hot ramp: blue (cold) → cyan → green → yellow → red → white
 * (hottest). It is a perceptually ordered "thermal" ramp so the busiest voxels
 * stand out as white-hot. `t` is clamped to `[0, 1]`.
 */
export function defaultColorRamp(t: number): readonly [number, number, number] {
  const x = clamp01(t);
  // Five linear segments across the ramp.
  const stops: ReadonlyArray<readonly [number, number, number]> = [
    [0.0, 0.1, 0.9], // cold blue
    [0.0, 0.85, 1.0], // cyan
    [0.1, 0.9, 0.2], // green
    [1.0, 0.85, 0.0], // yellow
    [1.0, 0.15, 0.0], // red
    [1.0, 1.0, 1.0], // white-hot
  ];
  const segments = stops.length - 1;
  const scaled = x * segments;
  const i = Math.min(Math.floor(scaled), segments - 1);
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  if (!a || !b) return [1, 1, 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Re-export the type so consumers can `import { ColorRamp } from "@uptimizr/heatmap"`. */
export type { ColorRamp };
