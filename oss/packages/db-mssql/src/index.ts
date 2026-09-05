/**
 * `@uptimizr/db-mssql` — the optional single-tenant Microsoft SQL Server store
 * (ADR 0020, #85).
 *
 * Composes the dialect-agnostic query layer and engine-neutral mappers from
 * `@uptimizr/db` with a pooled `mssql` (tedious) client, forward-only
 * migrations, and metadata helpers, so a self-hosted collector can swap DuckDB
 * for SQL Server / Azure SQL via `COLLECTOR_STORE=mssql` without any change to
 * routes, schema contracts, or the dashboard. Single-tenant only — no `org_id`,
 * no tenant isolation.
 *
 * Server/Node only — no DOM imports.
 */

export {
  createMssqlClient,
  resolveMssqlConfig,
  ensureMssqlDatabase,
  dropMssqlDatabase,
  assertSafeIdentifier,
  formatTemporal,
} from "./client.js";
export type { MssqlClient, MssqlClientOverrides, MssqlExecutor, MssqlRow } from "./client.js";

export { MSSQL_MIGRATIONS, migrateMssql } from "./migrations.js";

export { runMssqlQuery } from "./queries.js";

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
