import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createClickhouseStore } from "./clickhouseStore.js";
import { createDuckdbStore } from "./duckdbStore.js";
import { createMemoryStore } from "./memoryStore.js";
import type { CollectorStore } from "./store.js";

/**
 * Select the storage backend (`COLLECTOR_STORE`):
 * - `duckdb` (default) — the OSS single-file DuckDB store (events + metadata in
 *   one file, full analytics, zero external services; ADR 0020). Path from
 *   `DUCKDB_PATH`.
 * - `clickhouse` — the optional single-tenant ClickHouse store for scale
 *   (concurrent, high-volume ingestion; ADR 0020). Connection from the
 *   `CLICKHOUSE_*` env vars. Requires a reachable ClickHouse server.
 * - `memory` — a dependency-free in-memory store for local dev / E2E tests
 *   (seed its project/key via `COLLECTOR_MEMORY_PROJECT_ID` /
 *   `COLLECTOR_MEMORY_API_KEY`).
 */
export function createStore(env: NodeJS.ProcessEnv = process.env): Promise<CollectorStore> {
  switch (env.COLLECTOR_STORE) {
    case "memory":
      return Promise.resolve(
        createMemoryStore({
          projectId: env.COLLECTOR_MEMORY_PROJECT_ID ?? "demo",
          apiKey: env.COLLECTOR_MEMORY_API_KEY ?? "utk_memory_dev",
        }),
      );
    case "clickhouse":
      return createClickhouseStore();
    case "duckdb":
    default:
      return createDuckdbStore();
  }
}

/**
 * Wire the production store, build the app, and listen. Fails fast if required
 * configuration is missing (see {@link loadConfig}). Shared by the
 * `uptimizr-collector` bin and the `uptimizr serve` CLI command.
 */
export async function serve(): Promise<void> {
  const config = loadConfig();
  const store = await createStore();
  const app = await buildApp({ store, config, logger: true });

  if (!config.liveTokenSecretIsDedicated) {
    app.log.warn(
      "LIVE_TOKEN_SECRET is not set; live-session tokens are signed with VISITOR_HASH_SECRET. " +
        "Set a dedicated LIVE_TOKEN_SECRET in production so the two secrets are independent.",
    );
  }

  const close = async () => {
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await app.listen({ host: config.host, port: config.port });
}
