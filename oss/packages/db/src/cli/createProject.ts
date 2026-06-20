#!/usr/bin/env node
import {
  createApiKey as duckdbCreateApiKey,
  createProject as duckdbCreateProject,
} from "../duckdb/projects.js";
import { createDuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { readDbSettings } from "../env.js";

/**
 * Create a project and issue an API key, then print the pair. Unlike `seed.ts`
 * (which writes the single demo project into the root `.env`), this CLI is meant
 * to be run repeatedly to mint distinct projects — one per playground/scene. It
 * writes a machine-readable JSON line to **stdout** and human-readable progress
 * to **stderr**, so callers can capture the result cleanly:
 *
 * ```bash
 * pnpm --filter @uptimizr/db run new-project -- "My Scene"
 * ```
 *
 * Targets the OSS DuckDB store.
 */
async function main(): Promise<void> {
  const name =
    process.argv
      .slice(2)
      .filter((arg) => arg !== "--")
      .join(" ")
      .trim() || "Playground Project";

  const db = await createDuckdbClient(readDbSettings().duckdb.path);
  await migrateDuckdb(db);
  const project = await duckdbCreateProject(db, name);
  const { key } = await duckdbCreateApiKey(db, project.id);
  await db.close();
  printResult(project.id, project.name, key);
}

function printResult(projectId: string, name: string, apiKey: string): void {
  console.error(`✓ project created: ${projectId} (${name})`);
  console.error(`  API key (stored only as a hash; shown once): ${apiKey}`);
  process.stdout.write(`${JSON.stringify({ projectId, name, apiKey })}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
