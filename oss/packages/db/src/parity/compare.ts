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
 * 5. **Numeric columns must be JS numbers.** Parity is not only about *values*:
 *    a store that returns `"42"` where another returns `42` is not in parity,
 *    because every consumer then has to coerce (ADR 0051 §2). Pass
 *    {@link ParityCompareOptions.numericColumns} — normally
 *    {@link numericColumnsForSpec}, which reads the registry `row` schema of the
 *    metric the query was tagged with — and every one of those columns is
 *    asserted `typeof === "number"` (or `null`, for a column the registry
 *    declares nullable). This is what proves each store's runner coerces at its
 *    edge rather than leaving it to the caller.
 */

import { numericColumnsOfMetric } from "../query/coerce.js";
import type { QuerySpec } from "../query/types.js";

/** Absolute tolerance for floating-point column comparison. */
export const PARITY_ABS_TOLERANCE = 1e-6;

/** Relative tolerance for floating-point column comparison. */
export const PARITY_REL_TOLERANCE = 1e-9;

/**
 * Columns that carry an engine's **own rendering of stored data** rather than a
 * computed result, and so cannot be compared byte-for-byte across engines — the
 * same reason the wall-clock projections (`started_at`, `last_seen`, …) are
 * excluded.
 *
 * Today there is exactly one: `sample_payload` from
 * `buildCustomEventVocabulary` (ADR 0051 §5), the raw `custom` event document
 * a name's most recent rows carry. DuckDB, ClickHouse and SQL Server hand back
 * the stored text unchanged; the Postgres driver hands back an already-parsed
 * `jsonb` object with its keys reordered. Nothing downstream depends on that
 * rendering — `foldCustomEventVocabulary` reads only the prop keys and value
 * kinds out of it, and the collector never serves it — so what must agree across
 * engines is the counting and the sampling *shape*, which stays compared.
 *
 * Declared here rather than in each engine's suite so the exclusion is stated
 * once, with its reason.
 */
export const ENGINE_FORMATTED_COLUMNS: ReadonlySet<string> = new Set(["sample_payload"]);

export type ParityRow = Record<string, unknown>;

export interface ParityCompareOptions {
  /** Columns that, together, uniquely order a row for multiset comparison. */
  readonly sortKeys: readonly string[];
  /** Columns ignored entirely (engine-specific temporal renderings). */
  readonly ignoreColumns?: readonly string[];
  /**
   * Columns the registry declares numeric. Each is asserted to be a JS `number`
   * (or `null`) in every *actual* row — see tolerance rule 5. Usually supplied by
   * {@link numericColumnsForSpec}; omit to skip the type assertion.
   */
  readonly numericColumns?: readonly string[];
}

/**
 * The numeric columns of the metric a {@link QuerySpec} was tagged with, ready to
 * hand to {@link diffParity} as `numericColumns`. An untagged or unregistered
 * spec yields `[]` (no assertion), so this is always safe to call.
 */
export function numericColumnsForSpec(spec: QuerySpec): readonly string[] {
  return numericColumnsOfMetric(spec.metric);
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

  // Type parity (rule 5), checked before value parity so a store that hands back
  // string-encoded aggregates is named as such rather than as a value mismatch.
  for (const column of options.numericColumns ?? []) {
    if (ignore.has(column)) continue;
    for (let i = 0; i < actual.length; i++) {
      const value = actual[i]![column];
      if (value === undefined || value === null || typeof value === "number") continue;
      errors.push(
        `row ${i} column "${column}": expected a JS number (the store must coerce at its ` +
          `edge), got ${typeof value} ${JSON.stringify(value)}`,
      );
    }
  }

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
