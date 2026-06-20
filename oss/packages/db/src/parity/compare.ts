/**
 * Tolerance-aware row comparison for cross-engine parity (Phase C, ADR 0020).
 *
 * Two SQL engines (DuckDB for OSS, ClickHouse for the scale tier)
 * implement the same dialect-agnostic aggregations. Their numeric output can
 * differ in the last bits of floating-point arithmetic and their row order is
 * only as stable as the query's `ORDER BY`. This module encodes the tolerance
 * rules that let "equal analytics" be asserted despite those differences.
 *
 * ## Tolerance rules
 *
 * 1. **Order-insensitive.** Rows are compared as a multiset: both sides are
 *    sorted by the case's `sortKeys` before comparison. SQL guarantees no row
 *    order beyond an explicit `ORDER BY`, and ties under `ORDER BY count` are
 *    unstable across engines.
 * 2. **Float tolerance.** Numeric columns (averages, quantiles, ASOF ray
 *    origins/hits) match when their absolute difference is within
 *    {@link PARITY_ABS_TOLERANCE} or their relative difference is within
 *    {@link PARITY_REL_TOLERANCE}. Counts and bin indices are integers and so
 *    compare exactly under the same rule (difference 0).
 * 3. **Bin indices are integer-exact.** Heatmap bin columns come from
 *    `floor(...)` and are deterministic within an engine; they are integers and
 *    compared exactly. Inputs are chosen to avoid landing exactly on a bin
 *    boundary, where a sub-ulp difference could flip the floor across engines.
 * 4. **Temporal projections are excluded.** Wall-clock `TIMESTAMP` columns
 *    (e.g. `started_at`, `ended_at`, `last_seen`) are presentation metadata, not
 *    analytics, and their string rendering differs by engine; list them in a
 *    case's `ignoreColumns`. Date-granular `day` strings (`YYYY-MM-DD`) render
 *    identically in both engines and are compared.
 */

/** Absolute tolerance for floating-point column comparison. */
export const PARITY_ABS_TOLERANCE = 1e-6;

/** Relative tolerance for floating-point column comparison. */
export const PARITY_REL_TOLERANCE = 1e-9;

export type ParityRow = Record<string, unknown>;

export interface ParityCompareOptions {
  /** Columns that, together, uniquely order a row for multiset comparison. */
  readonly sortKeys: readonly string[];
  /** Columns ignored entirely (engine-specific temporal renderings). */
  readonly ignoreColumns?: readonly string[];
}

function numbersClose(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  if (diff <= PARITY_ABS_TOLERANCE) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return diff <= scale * PARITY_REL_TOLERANCE;
}

function sortKey(row: ParityRow, keys: readonly string[]): string {
  return JSON.stringify(keys.map((k) => row[k] ?? null));
}

function sortRows(rows: readonly ParityRow[], keys: readonly string[]): ParityRow[] {
  return [...rows].sort((a, b) => {
    const ka = sortKey(a, keys);
    const kb = sortKey(b, keys);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function cellsEqual(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "number" && typeof actual === "number") {
    return numbersClose(actual, expected);
  }
  // DuckDB returns numerics as JS numbers; guard against string/number drift.
  if (typeof expected === "number" && typeof actual === "string") {
    const n = Number(actual);
    return !Number.isNaN(n) && numbersClose(n, expected);
  }
  return Object.is(actual, expected);
}

/**
 * Compare engine output against golden rows under the tolerance rules above.
 * Returns a list of human-readable differences; an empty list means parity.
 */
export function diffParity(
  actual: readonly ParityRow[],
  golden: readonly ParityRow[],
  options: ParityCompareOptions,
): string[] {
  const errors: string[] = [];
  const ignore = new Set(options.ignoreColumns ?? []);

  if (actual.length !== golden.length) {
    errors.push(`row count: expected ${golden.length}, got ${actual.length}`);
    return errors;
  }

  const sortedActual = sortRows(actual, options.sortKeys);
  const sortedGolden = sortRows(golden, options.sortKeys);

  for (let i = 0; i < sortedGolden.length; i++) {
    const exp = sortedGolden[i]!;
    const act = sortedActual[i]!;
    for (const col of Object.keys(exp)) {
      if (ignore.has(col)) continue;
      if (!cellsEqual(act[col], exp[col])) {
        errors.push(
          `row ${i} column "${col}": expected ${JSON.stringify(exp[col])}, ` +
            `got ${JSON.stringify(act[col])}`,
        );
      }
    }
  }
  return errors;
}
