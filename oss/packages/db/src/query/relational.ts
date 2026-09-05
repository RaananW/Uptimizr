/**
 * Engine-neutral building blocks shared by the *relational* dialects
 * (ADR 0020) — the pieces that are not Postgres-specific and that the SQL
 * Server port (#85) is expected to reuse verbatim:
 *
 * 1. {@link renderNativeAsofJoin} — the `ASOF JOIN` clause for engines that
 *    have one (DuckDB, ClickHouse).
 * 2. {@link renderNearestRowJoin} — the ASOF *emulation* for row stores that
 *    lack it: a correlated nearest-row subquery (`LATERAL … LIMIT 1` on
 *    Postgres, `CROSS/OUTER APPLY … TOP 1` on SQL Server). Only the join
 *    keywords differ, so they are injected as {@link NearestRowJoinTokens}.
 * 3. {@link toPositionalParams} — rewrite the query layer's named `$name`
 *    placeholders to an engine's positional form (`$1` on Postgres, `@p1` on
 *    SQL Server) at execution time, so dialects stay pure string builders that
 *    never need to count parameters.
 *
 * Everything here is pure (no I/O, no client coupling) and isomorphic.
 */

import type { AsofJoinSpec } from "./dialect.js";

/** Render `ASOF INNER|LEFT JOIN <right> AS <alias> ON <keys> AND <ts predicate>`. */
export function renderNativeAsofJoin(spec: AsofJoinSpec): string {
  const kind = spec.kind === "left" ? "ASOF LEFT JOIN" : "ASOF INNER JOIN";
  const keys = spec.keys.map(([l, r]) => `${l} = ${spec.alias}.${r}`).join(" AND ");
  return `${kind} ${spec.right} AS ${spec.alias}
        ON ${keys} AND ${spec.leftTs} ${spec.op} ${spec.alias}.${spec.rightTs}`;
}

/**
 * Engine keywords for {@link renderNearestRowJoin}. Postgres:
 * `{ inner: "INNER JOIN LATERAL", left: "LEFT JOIN LATERAL", onTrue: "ON TRUE",
 * selectPrefix: "SELECT", selectSuffix: "LIMIT 1" }`. SQL Server would use
 * `CROSS APPLY` / `OUTER APPLY`, an empty `onTrue`, and `SELECT TOP 1` / `""`.
 */
export interface NearestRowJoinTokens {
  /** Introducer for the inner (row-dropping) variant. */
  readonly inner: string;
  /** Introducer for the left (row-keeping) variant. */
  readonly left: string;
  /** Trailing join condition, e.g. `ON TRUE` (empty for `APPLY`). */
  readonly onTrue: string;
  /** `SELECT` keyword, optionally carrying a row cap (`SELECT TOP 1`). */
  readonly selectPrefix: string;
  /** Trailing row cap after `ORDER BY` (`LIMIT 1`), or empty. */
  readonly selectSuffix: string;
}

/**
 * Flip a `leftTs <op> rightTs` comparison into the `rightTs <op'> leftTs` form a
 * correlated subquery filters with, plus the sort direction that puts the
 * nearest right row first.
 */
function nearestRowPredicate(op: AsofJoinSpec["op"]): { flipped: string; order: "ASC" | "DESC" } {
  switch (op) {
    case ">=":
      return { flipped: "<=", order: "DESC" };
    case ">":
      return { flipped: "<", order: "DESC" };
    case "<=":
      return { flipped: ">=", order: "ASC" };
    case "<":
      return { flipped: ">", order: "ASC" };
  }
}

/**
 * Emulate an ASOF join on an engine without one: for every left row, a
 * correlated subquery picks the single right row with equal keys and the
 * nearest timestamp in the requested direction. Exactly the semantics of
 * `ASOF JOIN` (ties on the right timestamp are broken arbitrarily on every
 * engine).
 *
 * Trade-off (documented in `@uptimizr/db-postgres`): the planner evaluates the
 * subquery once per left row — an index-backed nearest-row lookup — instead of
 * DuckDB/ClickHouse's single merge pass. Fine at the self-host scale this store
 * targets; the `(project_id, session_id, ts)` indexes exist for exactly this.
 */
export function renderNearestRowJoin(spec: AsofJoinSpec, t: NearestRowJoinTokens): string {
  const { flipped, order } = nearestRowPredicate(spec.op);
  const a = spec.alias;
  const keys = spec.keys.map(([l, r]) => `${a}.${r} = ${l}`).join(" AND ");
  const introducer = spec.kind === "left" ? t.left : t.inner;
  const suffix = t.selectSuffix ? ` ${t.selectSuffix}` : "";
  const onTrue = t.onTrue ? ` ${t.onTrue}` : "";
  return `${introducer} (
          ${t.selectPrefix} * FROM ${spec.right} AS ${a}
          WHERE ${keys} AND ${a}.${spec.rightTs} ${flipped} ${spec.leftTs}
          ORDER BY ${a}.${spec.rightTs} ${order}${suffix}
        ) AS ${a}${onTrue}`;
}

/** Result of {@link toPositionalParams}: the rewritten SQL and ordered values. */
export interface PositionalQuery {
  readonly sql: string;
  readonly values: unknown[];
}

/**
 * Rewrite named `$name` placeholders into positional ones. Each distinct name
 * is assigned the next index on first sight (so a name bound several times maps
 * to one value), and `render(index)` produces the engine's token (`$1`, `@p1`).
 * A placeholder with no bound value is a programming error and throws.
 *
 * Only bare `$identifier` tokens are rewritten; the query layer never emits a
 * `$` in any other position (no dollar-quoting, no JSON `$.path` on these
 * dialects), so no literal-awareness is needed.
 */
export function toPositionalParams(
  sql: string,
  params: Readonly<Record<string, unknown>>,
  render: (index: number) => string,
): PositionalQuery {
  const indexByName = new Map<string, number>();
  const values: unknown[] = [];
  const rewritten = sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    let index = indexByName.get(name);
    if (index === undefined) {
      if (!Object.prototype.hasOwnProperty.call(params, name)) {
        throw new Error(`Unbound query parameter "$${name}"`);
      }
      index = values.push(params[name]);
      indexByName.set(name, index);
    }
    return render(index);
  });
  return { sql: rewritten, values };
}
