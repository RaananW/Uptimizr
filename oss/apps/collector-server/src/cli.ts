#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCapabilityList } from "@uptimizr/db";
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
 * - `new-key <id>`       — mint an additional API key on an existing project,
 *                          with an explicit capability set, label and per-key
 *                          rate limit (#309, ADR 0051 §7).
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

/**
 * Split `--flag value` / `--flag=value` pairs out of an argument list, returning
 * the flags plus whatever positional arguments remain. Deliberately tiny: the
 * CLI has no dependency on an argument parser.
 */
function parseFlags(args: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--") || arg === "--") {
      if (arg !== "--") rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 2) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      flags[arg.slice(2)] = next;
      i += 1;
    }
  }
  return { flags, rest };
}

/** Parse a positive-integer flag, or throw with an actionable message. */
function intFlag(flags: Record<string, string>, name: string): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

/** Persist a generated secret so `serve` works on the next run. */
function ensureSecretPersisted(secret: string, generated: boolean, store: CliStoreKind): void {
  try {
    // `wx` creates the file only when it does not exist yet, so there is no
    // exists-then-write window in which another process could create it.
    writeFileSync(ENV_FILE, renderEnv(secret, store), { flag: "wx" });
    console.error(`✓ wrote ${ENV_FILE}`);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  if (!generated) return;
  const content = readFileSync(ENV_FILE, "utf8");
  if (/^VISITOR_HASH_SECRET=/m.test(content)) return;
  const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  appendFileSync(ENV_FILE, `${sep}VISITOR_HASH_SECRET=${secret}\n`);
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

/**
 * Mint an additional API key on an existing project with an explicit capability
 * set, label and optional per-key rate limit (#309, ADR 0051 §7):
 *
 * ```
 * uptimizr new-key <projectId> --capabilities query,annotate --label "weekly-report-agent"
 * ```
 *
 * Capabilities default to `query` (read-only), matching `init` / `new-project`.
 * `query:raw` additionally needs `ENABLE_RAW_SESSION_RETENTION` on the collector
 * before it grants anything (ADR 0003).
 */
async function cmdNewKey(args: string[]): Promise<void> {
  loadLocalEnv();
  const { flags, rest } = parseFlags(args);
  const projectId = rest[0];
  if (!projectId) {
    throw new Error(
      "Usage: uptimizr new-key <projectId> [--capabilities query,annotate] [--label NAME] " +
        "[--rate-limit-max N --rate-limit-window-ms M]",
    );
  }
  const capabilities = parseCapabilityList(flags.capabilities ?? "query");
  const rateLimitMax = intFlag(flags, "rate-limit-max");
  const rateLimitWindowMs = intFlag(flags, "rate-limit-window-ms");
  if ((rateLimitMax == null) !== (rateLimitWindowMs == null)) {
    throw new Error("--rate-limit-max and --rate-limit-window-ms must be given together");
  }

  const db = await openCliStore();
  try {
    const { key, record } = await db.createApiKey(projectId, {
      capabilities,
      label: flags.label ?? null,
      rateLimit:
        rateLimitMax != null && rateLimitWindowMs != null
          ? { max: rateLimitMax, windowMs: rateLimitWindowMs }
          : null,
    });
    console.error(`✓ API key created for project ${projectId}`);
    console.error(`  Capabilities: ${record.capabilities.join(", ")}`);
    if (record.label) console.error(`  Label:        ${record.label}`);
    if (record.rateLimit) {
      console.error(
        `  Rate limit:   ${record.rateLimit.max} requests / ${record.rateLimit.windowMs} ms`,
      );
    }
    console.error(`  API key (shown once): ${key}`);
    process.stdout.write(
      `${JSON.stringify({
        projectId,
        keyId: record.id,
        capabilities: record.capabilities,
        label: record.label,
        rateLimit: record.rateLimit,
        apiKey: key,
      })}\n`,
    );
  } finally {
    await db.close();
  }
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
      "  uptimizr new-key <projectId>  mint an additional API key on an existing project",
      "  uptimizr migrate              apply store migrations",
      "  uptimizr help                 show this help",
      "",
      "new-key options:",
      "  --capabilities <list>         comma-separated: ingest, query, annotate, query:raw",
      "                                (default: query). `query:raw` is only honoured when the",
      "                                collector runs with ENABLE_RAW_SESSION_RETENTION.",
      '  --label <name>                operator-supplied name, e.g. "weekly-report-agent"',
      "  --rate-limit-max <n>          per-key request budget (needs --rate-limit-window-ms)",
      "  --rate-limit-window-ms <ms>   per-key rate-limit window (needs --rate-limit-max)",
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
    case "new-key":
      await cmdNewKey(rest);
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
