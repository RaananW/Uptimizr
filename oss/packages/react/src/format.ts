import { heatRgb } from "./heat";

/**
 * Map a 0..1 intensity to an RGBA "heat" color for the 2D canvas heatmaps.
 * Delegates to {@link heatRgb} so the 2D viewers, the 3D viewers, and every
 * legend share one ramp (rust → ember → saffron).
 */
export function heatColor(t: number, alpha = 1): string {
  const [r, g, b] = heatRgb(t);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

/** Format an ISO/ClickHouse timestamp string for compact display. */
export function formatTime(value: string): string {
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

/** Parse an ISO/ClickHouse timestamp string to epoch-ms, or `NaN` if unparseable. */
export function parseTimestamp(value: string): number {
  return new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z").getTime();
}

export function formatNumber(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}
