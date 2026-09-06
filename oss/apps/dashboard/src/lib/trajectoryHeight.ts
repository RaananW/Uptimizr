import type { TrajectoryPoint } from "@/lib/api";

/**
 * Height (world Y) span, in scene units, below which a walked path is drawn
 * flat. First-person cameras bob and sample jitter adds a few centimetres of
 * noise even on a level floor, so a tiny span carries no information and would
 * only stretch the color ramp over nothing. Above it the path is color-coded by
 * height so ramps, stairs, lifts, and multi-floor routes read in plan view (#92).
 */
export const HEIGHT_FLAT_THRESHOLD = 0.25;

export interface HeightRange {
  min: number;
  max: number;
}

/**
 * Min/max camera height across a trajectory, ignoring non-finite samples.
 * Returns `null` when no point carries a usable Y.
 */
export function heightRange(points: readonly TrajectoryPoint[]): HeightRange | null {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.y)) continue;
    if (p.y < min) min = p.y;
    if (p.y > max) max = p.y;
  }
  return min <= max ? { min, max } : null;
}

/** Whether the range is wide enough to be worth encoding (see {@link HEIGHT_FLAT_THRESHOLD}). */
export function heightEncodingActive(range: HeightRange | null): boolean {
  return range !== null && range.max - range.min >= HEIGHT_FLAT_THRESHOLD;
}

/** Normalize a height to [0, 1] within `range` (0 = lowest point on the path, 1 = highest). */
export function heightT(y: number, range: HeightRange): number {
  const span = range.max - range.min;
  if (span <= 0 || !Number.isFinite(y)) return 0;
  return Math.max(0, Math.min(1, (y - range.min) / span));
}

/** Compact "1.5 m" style label for a legend end. */
export function formatHeight(value: number): string {
  return `${value.toFixed(1)} m`;
}
