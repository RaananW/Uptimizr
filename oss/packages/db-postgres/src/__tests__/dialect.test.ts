/**
 * Pure unit checks for the Postgres dialect (no server required).
 *
 * The dialect is a string builder, so these assert the engine-specific SQL
 * fragments render as expected — the contract the parity suite relies on when a
 * live Postgres is available — plus the shared relational helpers (ASOF
 * emulation, named→positional params) that the SQL Server port reuses.
 */

import { describe, expect, it } from "vitest";
import {
  buildClickGazeRay,
  buildSceneRetention,
  postgresDialect,
  toPositionalParams,
  toPostgresTimestamp,
} from "@uptimizr/db";

const d = postgresDialect;

describe("postgresDialect", () => {
  it("renders explicitly cast named placeholders", () => {
    expect(d.placeholder("projectId", "string")).toBe("$projectId::text");
    expect(d.placeholder("bins", "u32")).toBe("$bins::integer");
    expect(d.placeholder("cellSize", "f64")).toBe("$cellSize::double precision");
    expect(d.placeholder("since", "timestamp")).toBe("$since::timestamp");
    expect(d.placeholder("day", "date")).toBe("$day::date");
  });

  it("binds timestamps as naive-UTC literals", () => {
    const epoch = Date.UTC(2024, 5, 16, 10, 0, 0, 250);
    expect(toPostgresTimestamp(epoch)).toBe("2024-06-16 10:00:00.250");
    expect(d.timestampValue(epoch)).toBe("2024-06-16 10:00:00.250");
  });

  it("renders quantile / norm / array-length / conditional aggregates", () => {
    expect(d.quantile("fps", 0.5)).toBe(
      "percentile_cont(0.5) WITHIN GROUP (ORDER BY (fps)::double precision)",
    );
    expect(d.vectorNorm("direction")).toBe(
      "sqrt((SELECT sum(v * v) FROM unnest(direction) AS u(v)))",
    );
    expect(d.arrayLength("position")).toBe("cardinality(position)");
    expect(d.avgIf("dist", "active")).toBe("avg(dist) FILTER (WHERE active)");
    expect(d.anyValue("scene_id")).toBe("min(scene_id)");
  });

  it("renders epoch / time-bucket / date / text casts", () => {
    expect(d.epochMs("ts")).toBe("(EXTRACT(EPOCH FROM ts) * 1000)::bigint");
    expect(d.timeBucketMs("ts", "$interval::integer")).toBe(
      "(floor((EXTRACT(EPOCH FROM ts) * 1000)::bigint::double precision / ($interval::integer * 1000)) * ($interval::integer * 1000))::bigint",
    );
    expect(d.toDate("ts")).toBe("CAST(ts AS DATE)");
    expect(d.toText("day")).toBe("CAST(day AS TEXT)");
  });

  it("extracts JSON via jsonb paths with regex-guarded numeric casts", () => {
    expect(d.jsonText("payload", "device", "engine")).toBe(`(payload #>> '{"device","engine"}')`);
    expect(d.jsonInt("payload", "count")).toBe(
      `CASE WHEN (payload #>> '{"count"}') ~ '^-?[0-9]+$' THEN (payload #>> '{"count"}')::bigint END`,
    );
    expect(d.jsonFloat("payload", "uv", "0")).toBe(
      `CASE WHEN (payload #>> '{"uv","0"}') ~ '^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN (payload #>> '{"uv","0"}')::double precision END`,
    );
  });

  it("renders rollup merge combinators as plain pass-through aggregates", () => {
    expect(d.countMerge("samples_state")).toBe("sum(samples_state)");
    expect(d.avgMerge("avg_fps_state")).toBe("avg(avg_fps_state)");
    expect(d.quantileMerge("p50_fps_state", 0.5)).toBe(
      "percentile_cont(0.5) WITHIN GROUP (ORDER BY (p50_fps_state)::double precision)",
    );
  });

  it("emulates ASOF joins as LATERAL nearest-row subqueries", () => {
    const preceding = d.asofJoin({
      kind: "inner",
      right: "(SELECT session_id, ts, px FROM samples)",
      alias: "m",
      keys: [["c.session_id", "session_id"]],
      leftTs: "c.ts",
      op: ">=",
      rightTs: "ts",
    });
    expect(preceding).toContain("INNER JOIN LATERAL (");
    expect(preceding).toContain("SELECT * FROM (SELECT session_id, ts, px FROM samples) AS m");
    expect(preceding).toContain("WHERE m.session_id = c.session_id AND m.ts <= c.ts");
    expect(preceding).toContain("ORDER BY m.ts DESC LIMIT 1");
    expect(preceding).toContain(") AS m ON TRUE");

    const following = d.asofJoin({
      kind: "left",
      right: "sc",
      alias: "b",
      keys: [["a.session_id", "session_id"]],
      leftTs: "a.ts",
      op: "<",
      rightTs: "ts",
    });
    expect(following).toContain("LEFT JOIN LATERAL (");
    expect(following).toContain("WHERE b.session_id = a.session_id AND b.ts > a.ts");
    expect(following).toContain("ORDER BY b.ts ASC LIMIT 1");
  });

  it("renders the ASOF-based aggregations without any native ASOF keyword", () => {
    const rays = buildClickGazeRay("p", { since: 0, until: 1 }, d).query;
    const retention = buildSceneRetention("p", { since: 0, until: 1, limit: 5 }, d).query;
    for (const sql of [rays, retention]) {
      expect(sql).not.toMatch(/\bASOF\b/);
      expect(sql).toMatch(/JOIN LATERAL/);
      expect(sql).not.toMatch(/\bcount\(\)/);
      expect(sql).not.toMatch(/\blength\(/);
    }
  });
});

describe("toPositionalParams", () => {
  it("rewrites named placeholders to $n in first-seen order, reusing repeats", () => {
    const { sql, values } = toPositionalParams(
      "SELECT * FROM t WHERE a = $projectId::text AND b >= $since::timestamp AND c = $projectId::text",
      { since: "2024-06-16 10:00:00.000", projectId: "p1" },
      (i) => `$${i}`,
    );
    expect(sql).toBe("SELECT * FROM t WHERE a = $1::text AND b >= $2::timestamp AND c = $1::text");
    expect(values).toEqual(["p1", "2024-06-16 10:00:00.000"]);
  });

  it("supports other engines' tokens (e.g. @p1 for SQL Server)", () => {
    const { sql } = toPositionalParams("x = $a AND y = $b", { a: 1, b: 2 }, (i) => `@p${i}`);
    expect(sql).toBe("x = @p1 AND y = @p2");
  });

  it("throws on a placeholder with no bound value", () => {
    expect(() => toPositionalParams("x = $missing", {}, (i) => `$${i}`)).toThrow(/\$missing/);
  });

  it("renders every parity query with only positional placeholders", async () => {
    const { PARITY_CASES } = await import("@uptimizr/db");
    for (const parityCase of PARITY_CASES) {
      const spec = parityCase.build(d);
      const { sql } = toPositionalParams(spec.query, spec.query_params, (i) => `$${i}`);
      expect(sql, parityCase.name).not.toMatch(/\$[A-Za-z_]/);
    }
  });
});
