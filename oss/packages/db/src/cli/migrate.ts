#!/usr/bin/env node
import { createDuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { readDbSettings } from "../env.js";

/**
 * Apply migrations to the OSS single-file DuckDB store at `DUCKDB_PATH`.
 *
 * Run via `pnpm --filter @uptimizr/db migrate`.
 */
async function main(): Promise<void> {
  const { path } = readDbSettings().duckdb;
  const db = await createDuckdbClient(path);
  await migrateDuckdb(db);
  await db.close();

  console.log(`✓ migrations applied (DuckDB: ${path})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
