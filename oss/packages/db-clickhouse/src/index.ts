/**
 * `@uptimizr/db-clickhouse` — the optional single-tenant ClickHouse store
 * (ADR 0020).
 *
 * Composes the dialect-agnostic query layer and engine-neutral mappers from
 * `@uptimizr/db` with a ClickHouse client, forward-only migrations, and metadata
 * helpers, so a self-hosted collector can swap DuckDB for ClickHouse via
 * `COLLECTOR_STORE=clickhouse` without any change to routes, schema contracts, or
 * the dashboard. Single-tenant only — no `org_id`, no tenant isolation.
 *
 * Server/Node only — no DOM imports.
 */

export { createClickhouseClient } from "./client.js";
export type { ClickhouseClient, ClickhouseRow } from "./client.js";

export { CLICKHOUSE_MIGRATIONS, migrateClickhouse } from "./migrations.js";

export { runClickhouseQuery } from "./queries.js";

export { insertEvents, getSessionEvents, streamSessionEvents, getSessionMeta } from "./events.js";
export type { SessionMeta } from "./events.js";

export {
  createProject,
  getProject,
  createApiKey,
  resolveApiKey,
  hashApiKey,
  apiKeyPrefix,
  generateApiKey,
} from "./projects.js";
export type { Project, ApiKeyRecord } from "./projects.js";

export {
  upsertSceneProxy,
  getSceneRepresentation,
  listSceneRepresentations,
} from "./sceneRegistry.js";
export type {
  SceneRepresentation,
  SceneRepresentationKind,
  SceneRepresentationSummary,
} from "./sceneRegistry.js";
