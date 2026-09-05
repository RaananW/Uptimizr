/**
 * Pure unit checks for the SQL Server dialect and the T-SQL adaptation of the
 * shared SQL (no server required).
 *
 * The dialect is a string builder, so these assert the engine-specific SQL
 * fragments render as expected — the contract the parity suite relies on when a
 * live SQL Server is available — and that `toTsql` removes every construct
 * T-SQL cannot parse from every parity query (inline vector indexing, `LIMIT`,
 * `GROUP BY <alias>`, `atan2`).
 */

import { describe, expect, it } from "vitest";
import {
  PARITY_CASES,
  buildClickGazeRay,
  buildPointerHeatmap,
  buildSceneRetention,
  mssqlDialect,
  mssqlVectorElement,
  toMssqlTimestamp,
  toPositionalParams,
  toTsql,
} from "@uptimizr/db";
import { MSSQL_MIGRATIONS } from "../migrations.js";

const d = mssqlDialect;

describe("mssqlDialect", () => {
  it("renders named placeholders, cast in place where the driver would infer another type", () => {
    expect(d.placeholder("projectId", "string")).toBe("$projectId");
    expect(d.placeholder("bins", "u32")).toBe("$bins");
    expect(d.placeholder("cellSize", "f64")).toBe("CAST($cellSize AS float)");
    expect(d.placeholder("since", "timestamp")).toBe("CAST($since AS datetime2(3))");
    expect(d.placeholder("day", "date")).toBe("CAST($day AS date)");
  });

  it("binds timestamps as ISO-8601 naive-UTC literals", () => {
    const epoch = Date.UTC(2024, 5, 16, 10, 0, 0, 250);
    expect(toMssqlTimestamp(epoch)).toBe("2024-06-16T10:00:00.250");
    expect(d.timestampValue(epoch)).toBe("2024-06-16T10:00:00.250");
  });

  it("renders quantile as an exact packed-values aggregate (no WITHIN GROUP)", () => {
    expect(d.quantile("fps", 0.5)).toBe(
      "dbo.uptimizr_quantile(STRING_AGG(CONVERT(varchar(max), CONVERT(varchar(30), CAST((fps) AS float), 3)), ','), 0.5)",
    );
    expect(d.quantileMerge("p50_fps_state", 0.5)).toBe(d.quantile("p50_fps_state", 0.5));
  });

  it("renders vectors over JSON arrays (norm, length, element)", () => {
    expect(mssqlVectorElement("position", 0)).toBe(
      "TRY_CONVERT(float, JSON_VALUE(position, '$[0]'))",
    );
    expect(d.vectorNorm("direction")).toBe(
      "sqrt(power(coalesce(TRY_CONVERT(float, JSON_VALUE(direction, '$[0]')), 0), 2) + " +
        "power(coalesce(TRY_CONVERT(float, JSON_VALUE(direction, '$[1]')), 0), 2) + " +
        "power(coalesce(TRY_CONVERT(float, JSON_VALUE(direction, '$[2]')), 0), 2) + " +
        "power(coalesce(TRY_CONVERT(float, JSON_VALUE(direction, '$[3]')), 0), 2))",
    );
    expect(d.arrayLength("position")).toBe(
      "(CASE WHEN position IS NULL OR position = N'[]' THEN 0 ELSE LEN(position) - LEN(REPLACE(position, ',', '')) + 1 END)",
    );
  });

  it("renders conditional / any aggregates with float casts", () => {
    expect(d.avgIf("dist", "active = 1")).toBe(
      "avg(CASE WHEN active = 1 THEN CAST((dist) AS float) END)",
    );
    expect(d.anyValue("scene_id")).toBe("min(scene_id)");
    expect(d.countMerge("samples_state")).toBe("sum(samples_state)");
    expect(d.avgMerge("avg_fps_state")).toBe("avg(CAST((avg_fps_state) AS float))");
  });

  it("renders epoch / time-bucket / date / text conversions", () => {
    const epoch =
      "CAST(DATEDIFF_BIG(millisecond, CAST('1970-01-01T00:00:00' AS datetime2(3)), ts) AS float)";
    expect(d.epochMs("ts")).toBe(epoch);
    expect(d.timeBucketMs("ts", "$interval")).toBe(
      `(floor(${epoch} / ($interval * 1000)) * ($interval * 1000))`,
    );
    expect(d.toDate("ts")).toBe("CAST(ts AS date)");
    expect(d.toText("day")).toBe("CONVERT(nvarchar(30), day, 121)");
  });

  it("extracts JSON via JSON_VALUE with TRY_CONVERT numeric casts and binary collation", () => {
    expect(d.jsonText("payload", "device", "engine")).toBe(
      `JSON_VALUE(payload, '$."device"."engine"') COLLATE Latin1_General_100_BIN2`,
    );
    expect(d.jsonInt("payload", "count")).toBe(
      `CAST(TRY_CONVERT(bigint, JSON_VALUE(payload, '$."count"')) AS float)`,
    );
    expect(d.jsonFloat("payload", "uv", "0")).toBe(
      `TRY_CONVERT(float, JSON_VALUE(payload, '$."uv"[0]'))`,
    );
  });

  it("emulates ASOF joins with APPLY + TOP 1", () => {
    const preceding = d.asofJoin({
      kind: "inner",
      right: "(SELECT session_id, ts, px FROM samples)",
      alias: "m",
      keys: [["c.session_id", "session_id"]],
      leftTs: "c.ts",
      op: ">=",
      rightTs: "ts",
    });
    expect(preceding).toContain("CROSS APPLY (");
    expect(preceding).toContain("SELECT TOP 1 * FROM (SELECT session_id, ts, px FROM samples) AS m");
    expect(preceding).toContain("WHERE m.session_id = c.session_id AND m.ts <= c.ts");
    expect(preceding).toMatch(/ORDER BY m\.ts DESC\s*\) AS m\s*$/);

    const following = d.asofJoin({
      kind: "left",
      right: "sc",
      alias: "b",
      keys: [["a.session_id", "session_id"]],
      leftTs: "a.ts",
      op: "<",
      rightTs: "ts",
    });
    expect(following).toContain("OUTER APPLY (");
    expect(following).toContain("WHERE b.session_id = a.session_id AND b.ts > a.ts");
    expect(following).toContain("ORDER BY b.ts ASC");
    expect(following).not.toContain("ON TRUE");
  });
});

describe("toTsql", () => {
  it("rewrites inline vector indexing to JSON extraction (qualified and bare)", () => {
    expect(toTsql("SELECT position[1] AS x, m.direction[3] AS dz FROM events")).toBe(
      "SELECT TRY_CONVERT(float, JSON_VALUE(position, '$[0]')) AS x, " +
        "TRY_CONVERT(float, JSON_VALUE(m.direction, '$[2]')) AS dz FROM events",
    );
  });

  it("leaves the dialect's own JSON paths alone", () => {
    const sql = `SELECT ${d.jsonFloat("payload", "uv", "0")} AS u, ${mssqlVectorElement("screen", 1)} AS sy`;
    expect(toTsql(sql)).toBe(sql);
  });

  it("rewrites LIMIT to OFFSET/FETCH and atan2 to ATN2", () => {
    expect(toTsql("SELECT atan2(a, b) AS t FROM x ORDER BY t LIMIT $limit")).toBe(
      "SELECT ATN2(a, b) AS t FROM x ORDER BY t OFFSET 0 ROWS FETCH NEXT $limit ROWS ONLY",
    );
    expect(toTsql("ORDER BY ts DESC LIMIT 5")).toBe(
      "ORDER BY ts DESC OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY",
    );
  });

  it("replaces GROUP BY output aliases with their select-list expressions", () => {
    const sql = `
      SELECT floor(screen[1] * $bins) AS gx, CAST(ts AS date) AS day, count(*) AS count, mesh
      FROM events
      WHERE project_id = $projectId
      GROUP BY gx, day, mesh
      ORDER BY count DESC
      LIMIT $limit`;
    const out = toTsql(sql);
    expect(out).toContain(
      "GROUP BY floor(TRY_CONVERT(float, JSON_VALUE(screen, '$[0]')) * $bins), CAST(ts AS date), mesh",
    );
    expect(out).toContain("ORDER BY count DESC");
  });

  it("scopes alias substitution to the owning block (nested subqueries, CTEs, UNION ALL)", () => {
    const sql = `
      WITH per_session AS (
        SELECT session_id, floor(x / 2) AS b, count(*) AS n
        FROM (SELECT session_id, x, floor(y) AS b FROM t WHERE k IN (SELECT k FROM u GROUP BY k)) AS inner_t
        GROUP BY session_id, b
      )
      SELECT b, sum(n) AS total FROM per_session GROUP BY b
      UNION ALL
      SELECT coalesce(kind, '') AS b, count(*) AS total FROM v GROUP BY b
      ORDER BY b`;
    const out = toTsql(sql);
    expect(out).toContain("GROUP BY session_id, floor(x / 2)");
    expect(out).toContain("FROM per_session GROUP BY b\n");
    expect(out).toContain("FROM v GROUP BY coalesce(kind, '')");
    expect(out).toContain("(SELECT k FROM u GROUP BY k)");
  });

  it("does not treat WITHIN GROUP or windowed ORDER BY as block clauses", () => {
    const sql = `SELECT STRING_AGG(v, ',') WITHIN GROUP (ORDER BY v) AS packed, bucket, row_number() OVER (ORDER BY ts) AS rn FROM x GROUP BY bucket HAVING count(*) > 1`;
    expect(toTsql(sql)).toBe(sql);
  });

  it("renders every parity query without any construct T-SQL rejects", () => {
    for (const parityCase of PARITY_CASES) {
      const spec = parityCase.build(d);
      const sql = toTsql(spec.query);
      expect(sql, parityCase.name).not.toMatch(/\bLIMIT\b/);
      expect(sql, parityCase.name).not.toMatch(/\w\[\d+\]/);
      expect(sql, parityCase.name).not.toMatch(/\batan2\(/i);
      expect(sql, parityCase.name).not.toMatch(/\bASOF\b/);
      expect(sql, parityCase.name).not.toMatch(/\bLATERAL\b/);
      const { sql: positional } = toPositionalParams(sql, spec.query_params, (i) => `@p${i}`);
      expect(positional, parityCase.name).not.toMatch(/\$[A-Za-z_]/);
    }
  });

  it("is idempotent", () => {
    for (const build of [buildClickGazeRay, buildPointerHeatmap]) {
      const sql = toTsql(build("p", { since: 0, until: 1 }, d).query);
      expect(toTsql(sql)).toBe(sql);
    }
    const retention = toTsql(buildSceneRetention("p", { since: 0, until: 1, limit: 5 }, d).query);
    expect(retention).toMatch(/APPLY/);
  });
});

describe("MSSQL_MIGRATIONS", () => {
  it("creates the quantile helper before the views that use it, idempotently", () => {
    expect(MSSQL_MIGRATIONS[0]?.id).toBe("0000_quantile_function");
    expect(MSSQL_MIGRATIONS[0]?.sql).toContain("CREATE OR ALTER FUNCTION dbo.uptimizr_quantile");
    const perfDaily = MSSQL_MIGRATIONS.find((m) => m.id === "0009_perf_daily_view");
    expect(perfDaily?.sql).toContain("dbo.uptimizr_quantile(STRING_AGG(");
    for (const migration of MSSQL_MIGRATIONS) {
      expect(migration.sql, migration.id).toMatch(/IF (NOT EXISTS|OBJECT_ID)|CREATE OR ALTER/);
    }
  });
});
