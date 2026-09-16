#!/usr/bin/env node
import {
  createApiKey as duckdbCreateApiKey,
  createProject as duckdbCreateProject,
} from "../duckdb/projects.js";
import { createDuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { readDbSettings } from "../env.js";
import { parseCapabilityList, type ApiKeyCapability } from "../metadata.js";

/**
 * Create a project and issue an API key, then print the pair. Unlike `seed.ts`
 * (which writes the single demo project into the root `.env`), this CLI is meant
 * to be run repeatedly to mint distinct projects — one per playground/scene. It
 * writes a machine-readable JSON line to **stdout** and human-readable progress
 * to **stderr**, so callers can capture the result cleanly:
 *
 * ```bash
 * pnpm --filter @uptimizr/db run new-project -- "My Scene"
 * pnpm --filter @uptimizr/db run new-project -- --capabilities query,query:raw "My Scene"
 * ```
 *
 * The key is read-only (`query`) by default. Session replay and the live
 * per-session follow additionally need `query:raw` (#309, ADR 0051 §7), which
 * the collector only honours when `ENABLE_RAW_SESSION_RETENTION` is on
 * (ADR 0003).
 *
 * Targets the OSS DuckDB store.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  let capabilities: ApiKeyCapability[] = ["query"];
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--capabilities" || arg.startsWith("--capabilities=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      if (!value) throw new Error("Missing value for --capabilities");
      capabilities = parseCapabilityList(value);
      continue;
    }
    words.push(arg);
  }
  const name = words.join(" ").trim() || "Playground Project";

  const db = await createDuckdbClient(readDbSettings().duckdb.path);
  await migrateDuckdb(db);
  const project = await duckdbCreateProject(db, name);
  const { key } = await duckdbCreateApiKey(db, project.id, { capabilities });
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
