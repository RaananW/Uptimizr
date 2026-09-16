/**
 * Deterministic, locale-independent number and unit rendering for the `reading`
 * sentence (design sketch §B.1).
 *
 * `toLocaleString` is deliberately avoided: a summary is read by an agent and
 * compared in tests, so "1,234" must not become "1.234" because the collector
 * happens to run in a different locale. Every helper here also has to be
 * **total** — a `reading` may never contain `undefined` or `NaN`, so a missing
 * or non-finite value renders as `n/a` rather than leaking through.
 */

import type { ColumnUnit } from "@uptimizr/metrics";

/**
 * Units whose values may be summed across rows. Shares, `total` and the cluster
 * weights are only reported for these: adding FPS, a ratio or a bin index
 * together produces a number that means nothing, and a `share` derived from it
 * would be actively misleading.
 */
const ADDITIVE_UNITS: ReadonlySet<ColumnUnit> = new Set<ColumnUnit>([
  "count",
  "sessions",
  "ms",
  "s",
  "bytes",
  "world-units",
  "radians",
]);

/** Whether values in a column with this unit may be added together. */
export function isAdditiveUnit(unit: ColumnUnit | null | undefined): boolean {
  return unit != null && ADDITIVE_UNITS.has(unit);
}

/** Insert thousands separators into the integer part of a rendered number. */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Render a number for prose: thousands-grouped, with at most two decimals and
 * only when they carry information. Non-finite and missing values become `n/a`.
 */
export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const rounded = Math.abs(value) >= 1000 ? Math.round(value) : Math.round(value * 100) / 100;
  const sign = rounded < 0 ? "-" : "";
  const text = Math.abs(rounded).toFixed(Number.isInteger(rounded) ? 0 : 2);
  const [whole = "0", fraction] = text.split(".");
  // Trim a trailing zero decimal ("1.50" → "1.5"), but never the whole part.
  const trimmed = fraction == null ? "" : `.${fraction.replace(/0$/, "")}`;
  return `${sign}${group(whole)}${trimmed === "." ? "" : trimmed}`;
}

/** Render a 0..1 share as a percentage with one decimal; `n/a` when unknown. */
export function formatShare(share: number | null | undefined): string {
  if (share == null || !Number.isFinite(share)) return "n/a";
  return `${formatNumber(Math.round(share * 1000) / 10)}%`;
}

/** The suffix that turns a bare number into a quantity, e.g. `450` → `450 ms`. */
export function unitSuffix(unit: ColumnUnit | null | undefined): string {
  switch (unit) {
    case "sessions":
      return " sessions";
    case "ms":
      return " ms";
    case "s":
      return " s";
    case "fps":
      return " FPS";
    case "percent":
      return "%";
    case "world-units":
      return " units";
    case "radians":
      return " rad";
    case "bytes":
      return " bytes";
    default:
      // count / ratio / index / epoch-ms / id / label / timestamp read better bare.
      return "";
  }
}

/** A number rendered with its unit, e.g. `2,210` or `450 ms`. */
export function formatQuantity(
  value: number | null | undefined,
  unit: ColumnUnit | null | undefined,
): string {
  const rendered = formatNumber(value);
  return rendered === "n/a" ? rendered : `${rendered}${unitSuffix(unit)}`;
}

/** The plural noun for one row of a metric, used in prose. */
export function grainNoun(grain: string, count: number): string {
  const singular =
    grain === "mesh"
      ? "mesh"
      : grain === "scene"
        ? "scene"
        : grain === "session"
          ? "session"
          : grain === "bucket"
            ? "bucket"
            : grain === "bin"
              ? "bin"
              : grain === "voxel"
                ? "voxel"
                : "row";
  if (count === 1) return singular;
  return singular === "mesh" ? "meshes" : `${singular}s`;
}

/** Turn a column name into readable prose (`avg_js_heap_bytes` → `avg js heap bytes`). */
export function humanizeColumn(column: string): string {
  return column.replace(/_/g, " ");
}

/** Render a cell value for prose; objects and nullish values become `n/a`. */
export function formatLabel(value: unknown): string {
  if (value == null) return "(unattributed)";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return value.length === 0 ? "(unattributed)" : value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return "n/a";
}
