import { describe, expect, it } from "vitest";
import {
  buildSceneRetention,
  buildVariantLeaderboard,
  clickhouseDialect,
  duckdbDialect,
} from "../index.js";
import type { Dialect } from "../index.js";

/**
 * Regression guard for the ClickHouse experimental-join-condition fix
 * (buildSceneRetention / buildVariantLeaderboard).
 *
 * Both builders once emitted a plain (non-ASOF) `INNER JOIN … ON` whose `ON`
 * mixed a left and a right column in an inequality (`b.ts > a.ts`,
 * `c.ts >= fv.t0`, and the boundary rule). Stock ClickHouse rejects that shape
 * unless the session sets `allow_experimental_join_condition = 1`, so the hosted
 * product had to scope that experimental flag around exactly these two reads.
 *
 * These builders must now render SQL that runs on stock ClickHouse with default
 * settings: the only place a mixed-column inequality may appear in an `ON` is an
 * `ASOF` join (ClickHouse supports equality + one inequality there natively).
 * Anything else belongs in `WHERE`. This test fails if a future edit
 * reintroduces the forbidden pattern for either engine.
 */

const PID = "guard-project";
const RANGE = { since: 0, until: 10_000 };

/**
 * Scan `sql` for a non-ASOF `JOIN … ON …` whose `ON` clause compares two
 * table-qualified columns with an inequality (`<`, `<=`, `>`, `>=`). ASOF joins
 * are allowed to carry exactly one such inequality, so they are skipped. Returns
 * the offending `ON` clause, or `undefined` when the SQL is portable.
 */
function findMixedColumnInequalityJoinOn(sql: string): string | undefined {
  // Match each JOIN's ON clause up to the next clause-introducing keyword.
  const joinRe =
    /(\bASOF\s+)?\b(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+|CROSS\s+)?JOIN\b[\s\S]*?\bON\b([\s\S]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bUNION\b|\bJOIN\b|\)\s*(?:AS\b|,|SELECT\b)|$)/gi;
  // A qualified-column inequality, e.g. `b.ts > v.ts` or `c.ts >= fv.t0`.
  const mixedIneqRe = /\b\w+\.\w+\s*(?:<=|>=|<|>)\s*\w+\.\w+/;
  let m: RegExpExecArray | null;
  while ((m = joinRe.exec(sql)) !== null) {
    const isAsof = m[1] != null;
    const onClause = m[2];
    if (!isAsof && mixedIneqRe.test(onClause)) return onClause.trim();
  }
  return undefined;
}

describe("findMixedColumnInequalityJoinOn (self-check)", () => {
  it("flags a plain join with a mixed-column inequality in ON", () => {
    const bad = "SELECT * FROM a JOIN b ON a.id = b.id AND b.ts > a.ts GROUP BY x";
    expect(findMixedColumnInequalityJoinOn(bad)).toContain("b.ts > a.ts");
  });

  it("ignores the inequality carried by an ASOF join", () => {
    const ok = "SELECT * FROM a ASOF INNER JOIN b ON a.id = b.id AND a.ts < b.ts GROUP BY x";
    expect(findMixedColumnInequalityJoinOn(ok)).toBeUndefined();
  });

  it("ignores an inequality that lives in WHERE", () => {
    const ok = "SELECT * FROM a JOIN b ON a.id = b.id WHERE b.ts > a.ts GROUP BY x";
    expect(findMixedColumnInequalityJoinOn(ok)).toBeUndefined();
  });
});

const CONVERSION = { type: "custom", name: "add_to_cart" } as const;

const builders: ReadonlyArray<{ name: string; build: (d: Dialect) => string }> = [
  {
    name: "buildSceneRetention",
    build: (d) => buildSceneRetention(PID, { ...RANGE, limit: 50 }, d).query,
  },
  {
    name: "buildVariantLeaderboard",
    build: (d) => buildVariantLeaderboard(PID, { ...RANGE, conversion: CONVERSION }, d).query,
  },
];

describe.each(builders)("$name emits stock-ClickHouse-safe joins", ({ build }) => {
  for (const dialect of [clickhouseDialect, duckdbDialect]) {
    it(`has no non-ASOF mixed-column inequality JOIN ... ON (${dialect.name})`, () => {
      const offending = findMixedColumnInequalityJoinOn(build(dialect));
      expect(offending, `offending ON: ${offending}`).toBeUndefined();
    });
  }

  it("keeps its ordered semantics via an ASOF join or a WHERE filter", () => {
    // Sanity: the ordered "next event" logic did not simply vanish — it is either
    // an ASOF join or a post-join WHERE inequality, not silently dropped.
    const sql = build(clickhouseDialect);
    const hasAsof = /ASOF\s+INNER\s+JOIN/i.test(sql);
    const hasWhereInequality = /\bWHERE\b[\s\S]*\b\w+\.\w+\s*(?:<=|>=|<|>)\s*\w+\.\w+/i.test(sql);
    expect(hasAsof || hasWhereInequality).toBe(true);
  });
});
