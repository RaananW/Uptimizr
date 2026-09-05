/**
 * `@uptimizr/db-postgres` — the optional single-tenant PostgreSQL store
 * (ADR 0020, #84).
 *
 * Composes the dialect-agnostic query layer and engine-neutral mappers from
 * `@uptimizr/db` with a pooled `pg` client, forward-only migrations, and
 * metadata helpers, so a self-hosted collector can swap DuckDB for Postgres via
 * `COLLECTOR_STORE=postgres` without any change to routes, schema contracts, or
 * the dashboard. Single-tenant only — no `org_id`, no tenant isolation.
 *
 * Server/Node only — no DOM imports.
 */

export { createPostgresClient, assertSafeIdentifier } from "./client.js";
export type { PostgresClient, PostgresExecutor, PostgresRow } from "./client.js";

export { POSTGRES_MIGRATIONS, migratePostgres } from "./migrations.js";

export { runPostgresQuery } from "./queries.js";

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
