import { describe, expect, it } from "vitest";
import { openCliStore, renderEnv, resolveCliStoreKind } from "../cliStore.js";

describe("resolveCliStoreKind", () => {
  it("defaults to duckdb when COLLECTOR_STORE is unset or blank", () => {
    expect(resolveCliStoreKind({})).toBe("duckdb");
    expect(resolveCliStoreKind({ COLLECTOR_STORE: "" })).toBe("duckdb");
    expect(resolveCliStoreKind({ COLLECTOR_STORE: "  " })).toBe("duckdb");
  });

  it("accepts every persistent store `serve` knows", () => {
    for (const store of ["duckdb", "postgres", "mssql", "clickhouse"]) {
      expect(resolveCliStoreKind({ COLLECTOR_STORE: store })).toBe(store);
    }
  });

  it("rejects the memory store with a pointer to its seed variables", () => {
    expect(() => resolveCliStoreKind({ COLLECTOR_STORE: "memory" })).toThrow(
      /COLLECTOR_MEMORY_PROJECT_ID/,
    );
  });

  it("rejects unknown stores instead of silently bootstrapping DuckDB", () => {
    expect(() => resolveCliStoreKind({ COLLECTOR_STORE: "sqlite" })).toThrow(
      /Unknown COLLECTOR_STORE "sqlite"/,
    );
  });
});

describe("openCliStore (duckdb)", () => {
  it("migrates the store and mints a project + API key", async () => {
    const store = await openCliStore({ COLLECTOR_STORE: "duckdb", DUCKDB_PATH: ":memory:" });
    try {
      const project = await store.createProject("My Game");
      expect(project.id).toMatch(/[0-9a-f-]{36}/);
      expect(project.name).toBe("My Game");
      const { key } = await store.createApiKey(project.id);
      expect(key.length).toBeGreaterThan(16);
    } finally {
      await store.close();
    }
  });
});

describe("renderEnv", () => {
  it("writes the DuckDB defaults when nothing is configured", () => {
    const env = renderEnv("s3cret", "duckdb", {});
    expect(env).toContain("VISITOR_HASH_SECRET=s3cret");
    expect(env).toContain("COLLECTOR_STORE=duckdb");
    expect(env).toContain("DUCKDB_PATH=./data/uptimizr.duckdb");
    expect(env).toContain("COLLECTOR_PORT=4318");
  });

  it("persists the selected store and the connection variables that were set", () => {
    const env = renderEnv("s3cret", "postgres", {
      POSTGRES_URL: "postgresql://u:p@db:5432/uptimizr",
      POSTGRES_SCHEMA: "analytics",
      COLLECTOR_PORT: "5000",
      MSSQL_URL: "Server=elsewhere",
    });
    expect(env).toContain("COLLECTOR_STORE=postgres");
    expect(env).toContain("POSTGRES_URL=postgresql://u:p@db:5432/uptimizr");
    expect(env).toContain("POSTGRES_SCHEMA=analytics");
    expect(env).toContain("COLLECTOR_PORT=5000");
    expect(env).not.toContain("POSTGRES_POOL_MAX");
    expect(env).not.toContain("DUCKDB_PATH");
    expect(env).not.toContain("MSSQL_URL");
  });
});
