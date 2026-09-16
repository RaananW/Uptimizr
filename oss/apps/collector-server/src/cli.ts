#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sceneIdSchema, sceneRegionsSchema, type SceneRegion } from "@uptimizr/schema";
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
 * - `regions set|get`    — declare / read a scene's named regions (ADR 0051 §2).
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

async function cmdMigrate(): Promise<void> {
  loadLocalEnv();
  // Opening the store applies its migrations, exactly as `serve` does on boot.
  const db = await openCliStore();
  await db.close();
  console.error(`✓ migrations applied (${resolveCliStoreKind()})`);
}

/** Read `--<name> <value>` (or `--<name>=<value>`) out of a command's argv tail. */
function flagArg(args: string[], name: string): string | undefined {
  const prefix = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === prefix) return args[i + 1];
    if (arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1);
  }
  return undefined;
}

/** Positional arguments of a command: everything that is not a flag or its value. */
function positionalArgs(args: string[], flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") continue;
    const matched = flags.find((f) => arg === `--${f}`);
    if (matched) {
      i++; // skip the flag's value
      continue;
    }
    if (flags.some((f) => arg.startsWith(`--${f}=`))) continue;
    out.push(arg);
  }
  return out;
}

/**
 * Resolve the project a `regions` command targets: `--project <id>`, else
 * `UPTIMIZR_PROJECT_ID`. There is no "current project" concept in the OSS
 * collector (a store can hold several), so the id is explicit rather than
 * guessed — writing a scene's regions under the wrong project would silently
 * produce an empty-looking registry.
 */
function resolveProjectId(args: string[]): string {
  const projectId = flagArg(args, "project") ?? process.env.UPTIMIZR_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      "No project selected. Pass --project <projectId> (or set UPTIMIZR_PROJECT_ID). " +
        "`uptimizr init` prints the id it minted.",
    );
  }
  return projectId;
}

/**
 * Parse a regions file: either a bare array of regions or the
 * `{ "regions": [...] }` envelope the HTTP endpoint takes, so the same file
 * works with `curl -d @regions.json` and with this command. Validated against
 * `sceneRegionsSchema`, so a bad box or a duplicate id fails here with a precise
 * message instead of half-writing the set.
 */
function readRegionsFile(path: string): SceneRegion[] {
  const absolute = resolve(process.cwd(), path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (err) {
    throw new Error(`Could not read regions from ${absolute}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const candidate =
    Array.isArray(parsed) || parsed == null
      ? parsed
      : ((parsed as { regions?: unknown }).regions ?? parsed);
  const result = sceneRegionsSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid regions in ${absolute}:\n${issues}`);
  }
  return result.data;
}

/** Validate a scene id the same way the collector's route params do. */
function parseSceneId(value: string | undefined): string {
  const result = sceneIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid scene id ${JSON.stringify(value ?? "")}: expected 1-64 chars of [A-Za-z0-9._:-].`,
    );
  }
  return result.data;
}

/**
 * `uptimizr regions set <sceneId> --file regions.json` — replace a scene's
 * region set in the store the collector serves (ADR 0051 §2). Replace-the-set:
 * a region left out of the file is removed, and an empty array clears the scene.
 */
async function cmdRegionsSet(args: string[]): Promise<void> {
  loadLocalEnv();
  const positional = positionalArgs(args, ["file", "project"]);
  const sceneId = parseSceneId(positional[0]);
  const file = flagArg(args, "file");
  if (!file) throw new Error("`uptimizr regions set` needs --file <regions.json>.");
  const regions = readRegionsFile(file);
  const projectId = resolveProjectId(args);

  const db = await openCliStore();
  try {
    if (!(await db.getProject(projectId))) {
      throw new Error(`No project ${JSON.stringify(projectId)} in this store.`);
    }
    const stored = await db.putSceneRegions(projectId, sceneId, regions);
    console.error(`✓ ${stored.length} region(s) set on scene "${sceneId}" (project ${projectId})`);
    process.stdout.write(`${JSON.stringify(stored, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

/** `uptimizr regions get <sceneId>` — print a scene's stored regions as JSON. */
async function cmdRegionsGet(args: string[]): Promise<void> {
  loadLocalEnv();
  const positional = positionalArgs(args, ["project"]);
  const sceneId = parseSceneId(positional[0]);
  const projectId = resolveProjectId(args);

  const db = await openCliStore();
  try {
    // Check the project first: an unknown id would otherwise read as "this scene
    // has no regions" rather than "you named the wrong project".
    if (!(await db.getProject(projectId))) {
      throw new Error(`No project ${JSON.stringify(projectId)} in this store.`);
    }
    const regions = await db.getSceneRegions(projectId, sceneId);
    console.error(`${regions.length} region(s) on scene "${sceneId}" (project ${projectId})`);
    process.stdout.write(`${JSON.stringify(regions, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

/** Dispatch the `regions` sub-namespace (`set` / `get`). */
async function cmdRegions(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "set":
      await cmdRegionsSet(rest);
      return;
    case "get":
      await cmdRegionsGet(rest);
      return;
    default:
      throw new Error(
        `Unknown regions command ${JSON.stringify(sub ?? "")}. ` +
          "Expected: uptimizr regions set <sceneId> --file <regions.json> | " +
          "uptimizr regions get <sceneId>",
      );
  }
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
      "  uptimizr regions set <sceneId> --file <regions.json>",
      "                                declare a scene's named regions (replaces the set)",
      "  uptimizr regions get <sceneId>",
      "                                print a scene's named regions as JSON",
      "  uptimizr help                 show this help",
      "",
      "The regions commands target a project: pass --project <projectId> or set",
      "UPTIMIZR_PROJECT_ID. The file is either a bare array of",
      "{ id, label, bounds: [minX,minY,minZ,maxX,maxY,maxZ], description? } or a",
      '{ "regions": [...] } envelope.',
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
    case "regions":
      await cmdRegions(rest);
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
