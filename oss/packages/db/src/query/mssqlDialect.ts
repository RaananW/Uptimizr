/**
 * Microsoft SQL Server (T-SQL) dialect for the query layer (ADR 0020, #85).
 *
 * SQL Server is the optional single-tenant *relational* store for self-hosters
 * standardized on SQL Server / Azure SQL: a multi-writer server, so several
 * collector instances can share one database. Like the Postgres dialect it is a
 * *re-home + dialect emitter* — every aggregation stays authored once in
 * `aggregations.ts` — but it is the heaviest relational port, because T-SQL
 * lacks three things the shared SQL takes for granted:
 *
 * 1. **No array type.** Vector columns (`position`, `direction`, `hit_point`,
 *    `ray_origin`, `ray_direction`, `screen`, `rotation`, `scale`) are stored
 *    as JSON number arrays (`'[x,y,z]'`, `nvarchar`). Every element access goes
 *    through {@link mssqlVectorElement} (`JSON_VALUE(col, '$[i]')` +
 *    `TRY_CONVERT(float)`), including the shared SQL's inline `position[1]`
 *    indexing, which {@link toTsql} rewrites — this is the single place where
 *    the JSON-vector representation is known. `vectorNorm` and `arrayLength`
 *    are built over the same representation.
 * 2. **No `ASOF JOIN`.** `asofJoin` renders the shared nearest-row emulation
 *    (`renderNearestRowJoin`, `relational.ts`) as `CROSS APPLY` / `OUTER APPLY
 *    (SELECT TOP 1 … ORDER BY ts DESC)`.
 * 3. **No aggregate percentile.** T-SQL's `PERCENTILE_CONT` is a *window*
 *    function only, so it cannot appear in a `GROUP BY` select list next to
 *    `avg`/`count`. `quantile` therefore packs the group's values with
 *    `STRING_AGG` — a real aggregate — and a small T-SQL scalar function
 *    (`dbo.uptimizr_quantile`, created by the `@uptimizr/db-mssql` migrations)
 *    sorts them and computes the type-7 linear interpolation DuckDB's
 *    `quantile_cont` / Postgres' `percentile_cont` use. Exact, O(n log n) per
 *    group; documented as the store's performance trade-off.
 *
 * Two further T-SQL syntax gaps are closed by {@link toTsql} rather than by the
 * `Dialect` members, because the shared SQL cannot express them portably:
 * `LIMIT n` (→ `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY`) and `GROUP BY <select
 * alias>`, which T-SQL rejects (`Invalid column name`) and is replaced by the
 * alias's defining expression. `toTsql` is applied once, at execution time, by
 * `runMssqlQuery` in `@uptimizr/db-mssql`.
 *
 * Other notes:
 * - `epochMs` / `timeBucketMs` return `float` (exact for epoch milliseconds,
 *   which are far below 2^53). `bigint` would come back as a *string* from the
 *   TDS driver and `avg(bigint)` truncates in T-SQL; `float` avoids both.
 * - Integer `avg` truncates in T-SQL, so `avgIf` / `avgMerge` / `quantile`
 *   cast their input to `float`; the promoted numeric columns are `float`
 *   already.
 * - String columns use the binary collation {@link MSSQL_BIN_COLLATION}, so
 *   equality, `GROUP BY` and ordering are case-sensitive and code-point ordered
 *   exactly like DuckDB / Postgres; JSON extractions carry the same collation.
 * - Parameters are emitted as named `$name` tokens (cast in place for `f64`,
 *   `timestamp`, `date`) and rewritten to positional `@p1…@pn` by the shared
 *   `toPositionalParams`; timestamp params are bound as ISO-8601 `T`-separated
 *   naive-UTC strings (language/`DATEFORMAT`-independent) against
 *   `datetime2(3)` columns.
 * - Requires SQL Server 2022 (16.x) / Azure SQL: `GREATEST` / `LEAST` (2022),
 *   `STRING_AGG` / `STRING_SPLIT` / `JSON_VALUE` / `DATEDIFF_BIG` (2016+).
 */

import type { Dialect, ParamType } from "./dialect.js";
import { renderNearestRowJoin, type NearestRowJoinTokens } from "./relational.js";

/**
 * Format an epoch-millisecond timestamp as an ISO-8601 naive-UTC
 * `YYYY-MM-DDTHH:MM:SS.mmm` string for binding to a `datetime2(3)` column /
 * parameter. The `T` separator makes the literal language- and
 * `SET DATEFORMAT`-independent; the wall-clock value is the same one the DuckDB
 * / ClickHouse / Postgres stores bind.
 */
export function toMssqlTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

/** Join keywords for the SQL Server flavour of the nearest-row ASOF emulation. */
export const MSSQL_NEAREST_ROW_JOIN: NearestRowJoinTokens = {
  inner: "CROSS APPLY",
  left: "OUTER APPLY",
  onTrue: "",
  selectPrefix: "SELECT TOP 1",
  selectSuffix: "",
};

/**
 * Binary (case-sensitive, code-point ordered) collation applied to every string
 * column and JSON extraction, so string semantics match DuckDB / Postgres
 * instead of SQL Server's case-insensitive default.
 */
export const MSSQL_BIN_COLLATION = "Latin1_General_100_BIN2";

/** Schema-qualified name of the quantile helper function (see module doc). */
export const MSSQL_QUANTILE_FUNCTION = "dbo.uptimizr_quantile";

/** The Unix epoch as a `datetime2(3)` literal (ISO-8601, language-neutral). */
const MSSQL_EPOCH = "CAST('1970-01-01T00:00:00' AS datetime2(3))";

/**
 * The `index0`-th (0-based) element of a JSON number array as `float`, or NULL
 * when the array is shorter / the value is not numeric. The one place that
 * knows vectors are JSON on SQL Server (see module doc).
 */
export function mssqlVectorElement(expr: string, index0: number): string {
  return `TRY_CONVERT(float, JSON_VALUE(${expr}, '$[${index0}]'))`;
}

/** Render a trusted compile-time key path as a SQL Server JSON path. */
function jsonPath(path: readonly string[]): string {
  // Numeric components index a JSON array (0-based); the others are quoted
  // object keys so any key spelling is safe.
  return `$${path.map((k) => (/^\d+$/.test(k) ? `[${k}]` : `."${k}"`)).join("")}`;
}

/** `JSON_VALUE(column, '$.path')` — the value at `path` as text (NULL when absent). */
function jsonAt(column: string, path: readonly string[]): string {
  return `JSON_VALUE(${column}, '${jsonPath(path)}')`;
}

/**
 * The group's non-NULL values of `expr` packed into one comma-separated
 * `varchar(max)` of round-trippable floats (`CONVERT` style 3 = 17 significant
 * digits), consumed (and sorted) by `dbo.uptimizr_quantile`. Deliberately not
 * `WITHIN GROUP (ORDER BY …)`: T-SQL rejects two ordered aggregates with
 * different orderings in one scope, and the shared SQL routinely computes
 * quantiles of several expressions side by side.
 */
function packedValues(expr: string): string {
  return `STRING_AGG(CONVERT(varchar(max), CONVERT(varchar(30), CAST((${expr}) AS float), 3)), ',')`;
}

export const mssqlDialect: Dialect = {
  name: "mssql",
  placeholder(name, type: ParamType) {
    // The TDS driver infers `int`/`float`/`nvarchar` from the JS value; cast in
    // place where the inferred type could differ from the logical one (an
    // integral `f64` would bind as `int`) or where a string must become a date.
    switch (type) {
      case "f64":
        return `CAST($${name} AS float)`;
      case "timestamp":
        return `CAST($${name} AS datetime2(3))`;
      case "date":
        return `CAST($${name} AS date)`;
      default:
        return `$${name}`;
    }
  },
  timestampValue(epochMs) {
    return toMssqlTimestamp(epochMs as number);
  },
  quantile(expr, q) {
    return `${MSSQL_QUANTILE_FUNCTION}(${packedValues(expr)}, ${q})`;
  },
  vectorNorm(expr) {
    // No arrays: sum the squares of the JSON elements. All callers guard with
    // `arrayLength(expr) = 3`; up to four components are covered (quaternions)
    // and absent components contribute 0.
    const terms = [0, 1, 2, 3].map((i) => `power(coalesce(${mssqlVectorElement(expr, i)}, 0), 2)`);
    return `sqrt(${terms.join(" + ")})`;
  },
  arrayLength(expr) {
    // Vectors are flat JSON number arrays written by the store itself, so the
    // element count is the comma count + 1 (0 for `[]`). Pure scalar text
    // arithmetic — usable in WHERE, SELECT and GROUP BY alike (no subquery).
    return `(CASE WHEN ${expr} IS NULL OR ${expr} = N'[]' THEN 0 ELSE LEN(${expr}) - LEN(REPLACE(${expr}, ',', '')) + 1 END)`;
  },
  avgIf(value, cond) {
    return `avg(CASE WHEN ${cond} THEN CAST((${value}) AS float) END)`;
  },
  anyValue(expr) {
    // `min` is a valid "any" (callers use it on values constant within the
    // group) and ignores NULLs like DuckDB's `any_value`.
    return `min(${expr})`;
  },
  timeBucketMs(tsExpr, intervalPlaceholder) {
    // Float epoch-ms floored to the interval grid (same arithmetic as DuckDB /
    // ClickHouse / Postgres); the interval param is an `int`, the division is
    // float so it can never truncate.
    const bucket = `(${intervalPlaceholder} * 1000)`;
    return `(floor(${this.epochMs(tsExpr)} / ${bucket}) * ${bucket})`;
  },
  epochMs(tsExpr) {
    // `datetime2(3)` holds wall-clock UTC; DATEDIFF_BIG from the epoch is exact
    // milliseconds, returned as float (see module doc).
    return `CAST(DATEDIFF_BIG(millisecond, ${MSSQL_EPOCH}, ${tsExpr}) AS float)`;
  },
  toDate(expr) {
    return `CAST(${expr} AS date)`;
  },
  toText(expr) {
    // Style 121 renders dates as `YYYY-MM-DD` and datetime2 as
    // `YYYY-MM-DD HH:MM:SS.fff` (ISO, language-neutral); the shared SQL only
    // applies it to date-typed rollup columns.
    return `CONVERT(nvarchar(30), ${expr}, 121)`;
  },
  jsonText(column, ...path) {
    return `${jsonAt(column, path)} COLLATE ${MSSQL_BIN_COLLATION}`;
  },
  jsonInt(column, ...path) {
    // `TRY_CONVERT(bigint)` yields NULL for absent / non-integer text exactly
    // like DuckDB's `TRY_CAST(... AS BIGINT)`; widened to float so it never
    // reaches the driver as a bigint string nor truncates under `avg`.
    return `CAST(TRY_CONVERT(bigint, ${jsonAt(column, path)}) AS float)`;
  },
  jsonFloat(column, ...path) {
    return `TRY_CONVERT(float, ${jsonAt(column, path)})`;
  },
  // The daily rollups are query-time views (pre-grouped by day), so each read
  // GROUP BY sees exactly one source row per group and the "merge" of a single
  // precomputed value is a plain pass-through aggregate — as on DuckDB.
  countMerge(stateExpr) {
    return `sum(${stateExpr})`;
  },
  avgMerge(stateExpr) {
    return `avg(CAST((${stateExpr}) AS float))`;
  },
  quantileMerge(stateExpr, q) {
    return `${MSSQL_QUANTILE_FUNCTION}(${packedValues(stateExpr)}, ${q})`;
  },
  asofJoin(spec) {
    return renderNearestRowJoin(spec, MSSQL_NEAREST_ROW_JOIN);
  },
};

// ---------------------------------------------------------------------------
// T-SQL adaptation of the shared SQL (see module doc)
// ---------------------------------------------------------------------------

/**
 * Inline 1-based array indexing in the shared SQL: `position[1]`,
 * `m.direction[3]`, … Never matches the dialect's own JSON paths (`'$[0]'`,
 * `'$."uv"[0]'`), because those have no identifier directly before the `[`.
 */
const VECTOR_INDEX = /(?<![\w.$"])((?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*)\[(\d+)\]/g;

/** `LIMIT <param|literal>` — always the last clause of a block in the shared SQL. */
const LIMIT_CLAUSE = /\bLIMIT\s+(\$[A-Za-z_]\w*|\d+)\b/g;

/**
 * Rewrite a query rendered with {@link mssqlDialect} into T-SQL. Three
 * constructs of the shared SQL are not T-SQL and cannot be expressed through a
 * `Dialect` member without touching every aggregation:
 *
 * - `col[n]` (1-based vector indexing) → {@link mssqlVectorElement}`(col, n-1)`.
 * - `LIMIT n` → `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` (T-SQL requires an
 *   `ORDER BY`, which every `LIMIT` in the shared SQL has).
 * - `GROUP BY <alias>` → the alias's select-list expression (T-SQL: "Invalid
 *   column name"). Both DuckDB and Postgres accept output-column aliases in
 *   `GROUP BY`; T-SQL only accepts input columns and expressions.
 *
 * Plus the spelling difference `atan2` → `ATN2`. Pure and idempotent; applied
 * once per query by `runMssqlQuery`.
 */
export function toTsql(sql: string): string {
  return rewriteGroupByAliases(sql)
    .replace(VECTOR_INDEX, (_m, expr: string, index: string) =>
      mssqlVectorElement(expr, Number(index) - 1),
    )
    .replace(/\batan2\s*\(/gi, "ATN2(")
    .replace(LIMIT_CLAUSE, "OFFSET 0 ROWS FETCH NEXT $1 ROWS ONLY");
}

type ClauseKind = "select" | "from" | "groupBy" | "terminator" | "close";

interface Clause {
  kind: ClauseKind;
  /** Paren depth the keyword sits at (a `close` is recorded at the depth it closes). */
  depth: number;
  start: number;
  end: number;
}

/** Keywords that end a `GROUP BY` list within the same block. */
const GROUP_TERMINATORS = /^(HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT|WINDOW)\b/i;

/**
 * One pass over the SQL text: paren depth, string literals skipped, and the
 * clause keywords that matter for block detection. `WITHIN GROUP (` is not a
 * `GROUP BY`; keywords inside `OVER (…)` / subqueries sit at a deeper depth.
 */
function scanClauses(sql: string): Clause[] {
  const clauses: Clause[] = [];
  let depth = 0;
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i]!;
    if (ch === "'") {
      // Skip a string literal ('' is an escaped quote).
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      clauses.push({ kind: "close", depth, start: i, end: i + 1 });
      depth--;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && !/[\w.$]/.test(sql[i - 1] ?? " ")) {
      const rest = sql.slice(i);
      const word = /^[A-Za-z_]\w*/.exec(rest)![0];
      const upper = word.toUpperCase();
      let match: { kind: ClauseKind; length: number } | undefined;
      if (upper === "SELECT") match = { kind: "select", length: word.length };
      else if (upper === "FROM") match = { kind: "from", length: word.length };
      else if (upper === "GROUP") {
        const by = /^GROUP\s+BY\b/i.exec(rest);
        if (by) match = { kind: "groupBy", length: by[0].length };
      } else {
        const term = GROUP_TERMINATORS.exec(rest);
        if (term) match = { kind: "terminator", length: term[0].length };
      }
      if (match) clauses.push({ kind: match.kind, depth, start: i, end: i + match.length });
      i += word.length;
      continue;
    }
    i++;
  }
  return clauses;
}

/** Split on commas that sit outside parentheses and string literals. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const ALIASED_ITEM = /^([\s\S]*\S)\s+AS\s+([A-Za-z_]\w*)\s*$/i;
const BARE_IDENTIFIER = /^\s*([A-Za-z_]\w*)\s*$/;

/**
 * Replace output-column aliases in every `GROUP BY` list with the expression
 * that defines them in the owning `SELECT` list (nearest preceding `SELECT` at
 * the same paren depth; its list ends at the first `FROM` at that depth).
 */
function rewriteGroupByAliases(sql: string): string {
  const clauses = scanClauses(sql);
  let out = sql;
  // Walk backwards so earlier offsets stay valid after each replacement.
  for (let g = clauses.length - 1; g >= 0; g--) {
    const group = clauses[g]!;
    if (group.kind !== "groupBy") continue;
    let selectIdx = -1;
    for (let s = g - 1; s >= 0; s--) {
      const c = clauses[s]!;
      if (c.kind === "select" && c.depth === group.depth) {
        selectIdx = s;
        break;
      }
    }
    if (selectIdx < 0) continue;
    const from = clauses
      .slice(selectIdx + 1, g)
      .find((c) => c.kind === "from" && c.depth === group.depth);
    if (!from) continue;

    const selectList = out
      .slice(clauses[selectIdx]!.end, from.start)
      .replace(/^\s*(DISTINCT|TOP\s+\d+)\b/i, "");
    const aliases = new Map<string, string>();
    for (const item of splitTopLevel(selectList)) {
      const m = ALIASED_ITEM.exec(item.trim());
      if (m && m[1]!.trim() !== m[2]) aliases.set(m[2]!, m[1]!.trim());
    }
    if (aliases.size === 0) continue;

    const terminator = clauses
      .slice(g + 1)
      .find(
        (c) =>
          (c.kind === "terminator" && c.depth === group.depth) ||
          (c.kind === "close" && c.depth === group.depth),
      );
    const listEnd = terminator ? terminator.start : out.length;
    const list = out.slice(group.end, listEnd);
    const rewritten = splitTopLevel(list)
      .map((item) => {
        const id = BARE_IDENTIFIER.exec(item);
        const expr = id ? aliases.get(id[1]!) : undefined;
        return expr ? item.replace(id![1]!, expr) : item;
      })
      .join(",");
    out = out.slice(0, group.end) + rewritten + out.slice(listEnd);
  }
  return out;
}
