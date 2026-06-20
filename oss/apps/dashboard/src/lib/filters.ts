// Global filter state shared by every dashboard panel: a time window (the 4th
// dimension), an optional scene (ADR 0010), and an optional input source
// (ADR 0011). Panels merge `toQueryParams(...)` into their requests so the whole
// surface stays in sync.

import type { InputSource, QueryParams } from "./api";

export type TimeWindow = "1h" | "24h" | "7d" | "all" | "custom";

export interface FilterState {
  window: TimeWindow;
  /** Custom range bounds (epoch ms); used only when `window === "custom"`. */
  since?: number;
  until?: number;
  /** Selected scene id, or `undefined`/empty for all scenes. */
  scene?: string;
  /** Selected input source, or `undefined` for all sources. */
  source?: InputSource;
  /** Camera mode: viewer (orbit) vs first-person (walkable), or `undefined` for all (ADR 0026). */
  cameraMode?: "viewer" | "first-person";
}

/** Default to the last 24h so all-time averages never hide a recent regression. */
export const DEFAULT_FILTERS: FilterState = { window: "24h" };

export const TIME_PRESETS: { id: TimeWindow; label: string }[] = [
  { id: "1h", label: "Last hour" },
  { id: "24h", label: "Last 24h" },
  { id: "7d", label: "Last 7 days" },
  { id: "all", label: "All time" },
];

const WINDOW_MS: Record<"1h" | "24h" | "7d", number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

/** Resolve a filter state to a concrete `{ since, until }` range (epoch ms). */
export function resolveRange(
  state: FilterState,
  now = Date.now(),
): { since?: number; until?: number } {
  if (state.window === "all") return {};
  if (state.window === "custom") return { since: state.since, until: state.until };
  return { since: now - WINDOW_MS[state.window], until: now };
}

/** Merge the active filters into query params for a panel request. */
export function toQueryParams(state: FilterState, now = Date.now()): QueryParams {
  const range = resolveRange(state, now);
  return {
    ...range,
    scene: state.scene && state.scene.length > 0 ? state.scene : undefined,
    source: state.source,
    cameraMode: state.cameraMode,
  };
}

/** Friendly bucket steps (seconds) for the time-series strip. */
const INTERVAL_STEPS = [60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400, 604800];

/**
 * Pick a time-series bucket interval (seconds) targeting roughly `targetBuckets`
 * buckets across the span, snapped to a friendly step.
 */
export function pickInterval(spanMs: number, targetBuckets = 80): number {
  const target = Math.max(60, Math.round(spanMs / targetBuckets / 1000));
  return INTERVAL_STEPS.find((s) => s >= target) ?? 604800;
}

/** Format an input-source id for display (e.g. `xr-controller` → `XR controller`). */
export function formatSource(source: string): string {
  if (source === "xr-controller") return "XR controller";
  return source.charAt(0).toUpperCase() + source.slice(1);
}

export const INPUT_SOURCES: InputSource[] = [
  "mouse",
  "touch",
  "stylus",
  "pen",
  "xr-controller",
  "hand",
  "gaze",
  "transient",
  "other",
];
