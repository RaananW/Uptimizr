import type { QuerySpec } from "@uptimizr/db/query";

/**
 * A {@link QuerySpec} rewritten for DuckDB-Wasm's positional prepared-statement
 * binding.
 *
 * The shared query builders emit DuckDB **named** placeholders (`$name`,
 * `$name::TIMESTAMP`) plus a `query_params` record. DuckDB-Wasm prepared
 * statements bind **positionally** (`stmt.query(v1, v2, …)` → `$1, $2, …`), so we
 * rewrite each distinct `$name` to a stable `$N` index and collect the values in
 * index order. A name referenced more than once keeps the same `$N` (DuckDB
 * allows reusing a positional marker), so each value is bound exactly once.
 */
export interface PositionalQuery {
  /** SQL with every `$name` rewritten to its positional `$N` marker. */
  sql: string;
  /** Bound values in `$1…$N` order. */
  values: unknown[];
}

/**
 * Matches a DuckDB named placeholder: a `$` immediately followed by an
 * identifier (`$since`, `$projectId`). It deliberately does **not** match JSON
 * paths emitted by the dialect's `jsonText` (`'$.scene.cameraType'`) because the
 * character after `$` there is `.`, not an identifier start.
 */
const NAMED_PLACEHOLDER = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Rewrite a builder {@link QuerySpec} into a {@link PositionalQuery} for
 * DuckDB-Wasm. Pure and synchronous so it is unit-testable without a database.
 */
export function toPositionalQuery(spec: QuerySpec): PositionalQuery {
  const nameToIndex = new Map<string, number>();
  const values: unknown[] = [];

  const sql = spec.query.replace(NAMED_PLACEHOLDER, (_match, name: string) => {
    let index = nameToIndex.get(name);
    if (index === undefined) {
      index = nameToIndex.size + 1;
      nameToIndex.set(name, index);
      // `query_params` always carries a key for every emitted placeholder; fall
      // back to null rather than `undefined` so a missing key is bound as SQL NULL.
      values.push(name in spec.query_params ? spec.query_params[name] : null);
    }
    return `$${index}`;
  });

  return { sql, values };
}
