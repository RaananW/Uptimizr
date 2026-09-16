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
  duckdbCreateApiKey as createApiKey,
  hashApiKey,
  migrateDuckdb,
  type DuckdbClient,
} from "@uptimizr/db";

import {
  API_KEY,
  DUCKDB_PATH,
  PROJECT_ID,
  QUERY_ONLY_API_KEY,
  QUERY_ONLY_KEY_ID,
  RAW_API_KEY,
  RAW_KEY_ID,
} from "./constants.js";

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
    // The harness key drives every spec, including the replay/live-follow ones
    // and the scene-regions spec, so it carries `query:raw` and `annotate`
    // alongside `query` (#309, ADR 0051 §7) — region authoring is a metadata
    // write and needs `annotate`. The collector still only honours `query:raw`
    // because the harness runs with `ENABLE_RAW_SESSION_RETENTION=1` (see
    // `playwright.config.ts`).
    await db.run(
      `INSERT INTO api_keys (id, project_id, key_hash, key_prefix, capability, capabilities)
       VALUES ($id, $projectId, $keyHash, $keyPrefix, 'query', 'query,query:raw,annotate')`,
      {
        id: randomUUID(),
        projectId: PROJECT_ID,
        keyHash: hashApiKey(API_KEY),
        keyPrefix: apiKeyPrefix(API_KEY),
      },
    );

    // Agent-scoped keys for the capability suite (#309, ADR 0051 §7). Minted
    // through the store's own `createApiKey` so the spec exercises the same
    // capability-set write path the `uptimizr new-key` CLI uses, then rewritten
    // to the fixed ids/hashes the specs assert on — the harness stays hermetic
    // and the assertions stay readable.
    for (const [id, plaintext, capabilities, label] of [
      [QUERY_ONLY_KEY_ID, QUERY_ONLY_API_KEY, ["query"], "e2e-query-only-agent"],
      [RAW_KEY_ID, RAW_API_KEY, ["query", "query:raw"], "e2e-replay-agent"],
    ] as const) {
      const { key } = await createApiKey(db, PROJECT_ID, {
        capabilities: [...capabilities],
        label,
      });
      await db.run(
        `UPDATE api_keys SET id = $id, key_hash = $keyHash, key_prefix = $keyPrefix
          WHERE key_hash = $mintedHash`,
        {
          id,
          keyHash: hashApiKey(plaintext),
          keyPrefix: apiKeyPrefix(plaintext),
          mintedHash: hashApiKey(key),
        },
      );
    }
  } finally {
    await db.close();
  }

  console.log(`✓ seeded e2e DuckDB store at ${DUCKDB_PATH} (project ${PROJECT_ID})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
