#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CliStoreKind, openCliStore, renderEnv, resolveCliStoreKind } from "./cliStore.js";

/**
 * Unified `uptimizr` CLI (ADR 0029) — collapses the multi-step npm self-host
 * (`export VISITOR_HASH_SECRET` → `uptimizr-db-new-project` → `uptimizr-collector`)
 * into `uptimizr init && uptimizr serve`.
 *
 * Subcommands:
 * - `init`               — generate a visitor-hash secret, create + migrate the
 *                          store, mint a first project + API key, and write `.env`.
 * - `serve` (default)    — run the ingestion + query API (see {@link serve}).
 * - `new-project <name>` — mint an additional project + API key.
 * - `migrate`            — apply store migrations.
 *
 * Every command targets the store selected by `COLLECTOR_STORE` — the OSS
 * DuckDB default (no Docker, no external database; ADR 0020), or the optional
 * `postgres` / `mssql` / `clickhouse` stores — read through the same connection
 * variables `serve` uses, so the project minted by `init` is the one the running
 * collector resolves.
 */

const ENV_FILE = resolve(process.cwd(), ".env");

/** Load a local `.env` (Node 22 built-in) so `serve`/`migrate` see config without a wrapper. */
function loadLocalEnv(): void {
  if (existsSync(ENV_FILE)) {
    process.loadEnvFile(ENV_FILE);
  }
}

/** Join positional args into a project name, dropping a stray `--` separator. */
function nameArg(args: string[]): string {
  return args
    .filter((a) => a !== "--")
    .join(" ")
    .trim();
}

/** Persist a generated secret so `serve` works on the next run. */
function ensureSecretPersisted(secret: string, generated: boolean, store: CliStoreKind): void {
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, renderEnv(secret, store));
    console.error(`✓ wrote ${ENV_FILE}`);
    return;
  }
  if (!generated) return;
  const content = readFileSync(ENV_FILE, "utf8");
  if (/^VISITOR_HASH_SECRET=/m.test(content)) return;
  const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  writeFileSync(ENV_FILE, `${content}${sep}VISITOR_HASH_SECRET=${secret}\n`);
  console.error(`✓ added VISITOR_HASH_SECRET to ${ENV_FILE}`);
}

async function cmdInit(name: string): Promise<void> {
  loadLocalEnv();

  let secret = process.env.VISITOR_HASH_SECRET;
  const generated = !secret;
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    process.env.VISITOR_HASH_SECRET = secret;
  }

  const store = resolveCliStoreKind();
  const db = await openCliStore();
  const project = await db.createProject(name);
  const { key } = await db.createApiKey(project.id);
  await db.close();

  ensureSecretPersisted(secret, generated, store);

  const port = Number(process.env.COLLECTOR_PORT ?? 4318);
  console.error("\n✓ Uptimizr is ready.");
  console.error(`  Store:    ${store}`);
  console.error(`  Project:  ${project.id} (${project.name})`);
  console.error(`  API key:  ${key}  (shown once — put it in your app config)`);
  console.error(`  Endpoint: http://localhost:${port}/api/v1`);
  console.error("\nNext: uptimizr serve");
}

async function cmdNewProject(name: string): Promise<void> {
  loadLocalEnv();
  const db = await openCliStore();
  const project = await db.createProject(name);
  const { key } = await db.createApiKey(project.id);
  await db.close();

  console.error(`✓ project created: ${project.id} (${project.name})`);
  console.error(`  API key (shown once): ${key}`);
  process.stdout.write(
    `${JSON.stringify({ projectId: project.id, name: project.name, apiKey: key })}\n`,
  );
}

async function cmdMigrate(): Promise<void> {
  loadLocalEnv();
  // Opening the store applies its migrations, exactly as `serve` does on boot.
  const db = await openCliStore();
  await db.close();
  console.error(`✓ migrations applied (${resolveCliStoreKind()})`);
}

function printUsage(): void {
  console.error(
    [
      "uptimizr — self-host the OSS 3D-analytics collector (DuckDB by default, no Docker).",
      "",
      "Usage:",
      "  uptimizr init [name]          generate a secret, create the store, mint a project + key, write .env",
      "  uptimizr serve                run the ingestion + query API (default)",
      "  uptimizr new-project <name>   mint an additional project + API key",
      "  uptimizr migrate              apply store migrations",
      "  uptimizr help                 show this help",
      "",
      "Every command targets the store selected by COLLECTOR_STORE (duckdb | postgres | mssql |",
      "clickhouse), using the same connection variables as `serve` (DUCKDB_PATH, POSTGRES_URL,",
      "MSSQL_URL, CLICKHOUSE_*). Unset = duckdb.",
      "",
      "Quick start:  uptimizr init  &&  uptimizr serve",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "serve": {
      loadLocalEnv();
      const { serve } = await import("./serve.js");
      await serve();
      return;
    }
    case "init":
      await cmdInit(nameArg(rest) || "Default Project");
      return;
    case "new-project":
      await cmdNewProject(nameArg(rest) || "Project");
      return;
    case "migrate":
      await cmdMigrate();
      return;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
