/**
 * Deterministic DuckDB provisioning for the e2e harness.
 *
 * The end-to-end suite runs the collector against the OSS single-file DuckDB
 * store (ADR 0020) — not the in-memory store — so the dashboard's analytics
 * aggregations have real data to render. DuckDB is single-writer, so this script
 * MUST run to completion (and close its handle) *before* the collector opens the
 * same file: the Playwright `webServer` command chains it with `&&`.
 *
 * It recreates the store from scratch on every run (deleting any prior file) and
 * seeds one project + a fixed API key so the playground, collector, and dashboard
 * all agree on the same `projectId` / key without dynamic plumbing. API keys are
 * stored only as SHA-256 hashes, so the fixed plaintext is hashed here exactly as
 * the collector will hash the incoming `x-api-key`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import {
  apiKeyPrefix,
  createDuckdbClient,
  hashApiKey,
  migrateDuckdb,
  type DuckdbClient,
} from "@uptimizr/db";

import { API_KEY, DUCKDB_PATH, PROJECT_ID } from "./constants.js";

async function main(): Promise<void> {
  // Start from a clean slate so aggregations are deterministic across runs.
  mkdirSync(dirname(DUCKDB_PATH), { recursive: true });
  for (const suffix of ["", ".wal", ".tmp"]) {
    rmSync(`${DUCKDB_PATH}${suffix}`, { force: true, recursive: true });
  }

  const db: DuckdbClient = await createDuckdbClient(DUCKDB_PATH);
  try {
    await migrateDuckdb(db);

    // Fixed project + API key (idempotent: the file was just recreated).
    await db.run(`INSERT INTO projects (id, name) VALUES ($id, $name)`, {
      id: PROJECT_ID,
      name: "E2E",
    });
    await db.run(
      `INSERT INTO api_keys (id, project_id, key_hash, key_prefix)
       VALUES ($id, $projectId, $keyHash, $keyPrefix)`,
      {
        id: randomUUID(),
        projectId: PROJECT_ID,
        keyHash: hashApiKey(API_KEY),
        keyPrefix: apiKeyPrefix(API_KEY),
      },
    );
  } finally {
    await db.close();
  }

  console.log(`✓ seeded e2e DuckDB store at ${DUCKDB_PATH} (project ${PROJECT_ID})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
