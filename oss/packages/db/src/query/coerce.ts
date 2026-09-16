/**
 * **Numeric coercion at the store edge** (ADR 0051 §2, design sketch §B.3).
 *
 * SQL engines disagree about how a 64-bit integer or a decimal crosses the wire.
 * DuckDB, Postgres and SQL Server hand the driver plain JS numbers; ClickHouse
 * renders some of them as JSON *strings* over HTTP. Historically every consumer
 * — the dashboard, an agent, a CLI — had to defend itself, and agents routinely
 * summed strings.
 *
 * This module moves that defence to the one place it belongs: the single point
 * where rows leave a store's driver. {@link coerceRows} takes the metric that was
 * run and the rows it produced, reads which columns the registry declares
 * numeric, and parses any of them that arrived as a string. Every store runner
 * (`runDuckdbQuery`, `runClickhouseQuery`, `runPostgresQuery`, `runMssqlQuery`)
 * applies it, so **the collector always emits numbers** and the registry `row`
 * schemas can be strict `z.number()` — describing what the API actually emits
 * rather than what it might emit.
 *
 * ## What is coerced
 *
 * Only columns the registry's `row` schema declares as numbers (through any
 * combination of `.nullable()`, `.optional()` and `.default()`). `null` and
 * `undefined` pass through untouched — a metric an engine or connector does not
 * report must stay absent, never become `0`.
 *
 * ## Junk policy (deliberate, and asymmetric)
 *
 * A value in a numeric column that is neither a number, `null`/`undefined`, nor
 * a finite numeric string is *junk*: a driver or a query has produced something
 * the registry does not describe.
 *
 * - **Under test** (`VITEST` / `NODE_ENV=test`) it **throws** a message naming
 *   the metric, the column and the offending value, so a dialect regression
 *   fails loudly in CI rather than being smoothed over.
 * - **In production** the value is **left untouched** and a warning is logged
 *   **once per `metric.column`** (never per row — a million-row heatmap must not
 *   produce a million log lines). A malformed cell must not take down a read
 *   endpoint, and silently turning it into `NaN` would be worse than passing it
 *   through: `NaN` poisons a chart invisibly, while the original value is at
 *   least diagnosable.
 *
 * Callers can pin either behaviour explicitly with `{ strict }`.
 *
 * ## Cost
 *
 * Zero-allocation when there is nothing to do. Rows are copied lazily: the input
 * array is returned as-is unless some cell actually changes, and only rows that
 * change are cloned. The engines that already return numbers therefore pay one
 * `typeof` per numeric cell and allocate nothing.
 */

import type { z } from "zod";
import { getMetric, type MetricDefinition, type MetricId } from "@uptimizr/metrics";

/** Options for {@link coerceRows}. */
export interface CoerceRowsOptions {
  /**
   * Throw on a non-numeric value in a numeric column instead of leaving it
   * untouched. Defaults to `true` under a test runner and `false` otherwise (see
   * the junk policy in the module doc).
   */
  strict?: boolean;
  /**
   * Sink for the once-per-column production warning. Defaults to `console.warn`.
   * Pass a no-op to silence it, or the collector's logger to route it.
   */
  onWarn?: (message: string) => void;
}

/** Columns already warned about, so the log line is emitted once per column. */
const warned = new Set<string>();

/** Memoised numeric-column lists, keyed by the row schema object itself. */
const numericColumnCache = new WeakMap<z.ZodObject, readonly string[]>();

/**
 * Whether a Zod schema ultimately describes a number, looking through the
 * wrappers the registry uses (`.nullable()`, `.optional()`, `.default()`).
 */
function isNumericSchema(schema: unknown): boolean {
  let node = schema as { def?: { type?: string; innerType?: unknown } } | undefined;
  for (let depth = 0; node?.def != null && depth < 8; depth++) {
    const { type, innerType } = node.def;
    if (type === "number") return true;
    if (innerType == null) return false;
    node = innerType as { def?: { type?: string; innerType?: unknown } };
  }
  return false;
}

/**
 * The columns of a registry `row` schema whose values must be numbers. Memoised
 * per schema object — the registry is a module-level constant, so every metric's
 * list is computed at most once per process.
 */
export function numericColumns(row: z.ZodObject): readonly string[] {
  const cached = numericColumnCache.get(row);
  if (cached) return cached;
  const columns = Object.entries(row.shape)
    .filter(([, schema]) => isNumericSchema(schema))
    .map(([name]) => name);
  numericColumnCache.set(row, columns);
  return columns;
}

/** The numeric columns of a metric, by id or definition; `[]` when unknown. */
export function numericColumnsOfMetric(
  metric: MetricId | MetricDefinition | undefined,
): readonly string[] {
  const definition = resolveMetric(metric);
  return definition ? numericColumns(definition.row) : [];
}

function resolveMetric(
  metric: MetricId | MetricDefinition | undefined,
): MetricDefinition | undefined {
  if (metric == null) return undefined;
  return typeof metric === "string" ? getMetric(metric) : metric;
}

/**
 * Parse a string that a driver used to encode a number. Returns `undefined` when
 * the string is not a finite number — JSON cannot carry `Infinity`/`NaN`, so a
 * string that parses to one is a driver artefact, not a value, and is treated as
 * junk rather than silently becoming a non-finite number.
 */
function parseNumericString(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** True under Vitest or an explicit `NODE_ENV=test`; see the junk policy. */
function inTestEnvironment(): boolean {
  const env = typeof process === "undefined" ? undefined : process.env;
  if (env == null) return false;
  return env.VITEST === "true" || env.VITEST_WORKER_ID != null || env.NODE_ENV === "test";
}

function reportJunk(
  metricId: string,
  column: string,
  value: unknown,
  options: CoerceRowsOptions,
): void {
  const rendered = typeof value === "string" ? JSON.stringify(value) : String(value);
  const message =
    `coerceRows: ${metricId}.${column} is declared numeric but received ${rendered} ` +
    `(${typeof value}); leaving it untouched`;
  if (options.strict ?? inTestEnvironment()) {
    throw new TypeError(message.replace("; leaving it untouched", ""));
  }
  const key = `${metricId}.${column}`;
  if (warned.has(key)) return;
  warned.add(key);
  (options.onWarn ?? ((text: string) => console.warn(text)))(message);
}

/**
 * Parse every string-encoded value in a metric's numeric columns into a number.
 *
 * Applied by each store's query runner at the single point rows leave the
 * driver, so every consumer of the collector sees numbers regardless of engine.
 * Returns the input array untouched when nothing needed coercion (the common
 * case on DuckDB / Postgres / SQL Server), and otherwise a new array in which
 * only the changed rows are fresh objects.
 *
 * `metric` may be a registry id, a resolved {@link MetricDefinition}, or
 * `undefined` — an unregistered or untagged query is passed straight through, so
 * this is always safe to call.
 */
export function coerceRows<T>(
  metric: MetricId | MetricDefinition | undefined,
  rows: readonly T[],
  options: CoerceRowsOptions = {},
): T[] {
  const definition = resolveMetric(metric);
  if (definition == null || rows.length === 0) return rows as T[];
  const columns = numericColumns(definition.row);
  if (columns.length === 0) return rows as T[];

  let out: T[] | undefined;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    if (row == null || typeof row !== "object") {
      out?.push(rows[i] as T);
      continue;
    }
    let copy: Record<string, unknown> | undefined;
    for (const column of columns) {
      const value = row[column];
      if (value == null || typeof value === "number") continue;
      if (typeof value === "string") {
        const parsed = parseNumericString(value);
        if (parsed === undefined) {
          reportJunk(definition.id, column, value, options);
          continue;
        }
        copy ??= { ...row };
        copy[column] = parsed;
        continue;
      }
      reportJunk(definition.id, column, value, options);
    }
    if (copy != null) {
      out ??= rows.slice(0, i) as T[];
      out.push(copy as T);
    } else {
      out?.push(rows[i] as T);
    }
  }
  return out ?? (rows as T[]);
}

/**
 * Test-only: forget which columns have already been warned about, so a test can
 * assert the once-per-column behaviour without leaking state between cases.
 */
export function resetCoercionWarnings(): void {
  warned.clear();
}
