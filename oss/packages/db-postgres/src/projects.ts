import { randomUUID } from "node:crypto";
import {
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  parseApiKeyCapabilities,
  toApiKeyColumns,
  toApiKeyRateLimit,
  type ApiKeyRecord,
  type CreateApiKeyOptions,
  type Project,
  type ResolvedApiKey,
} from "@uptimizr/db";
import type { PostgresClient } from "./client.js";

export type { Project, ApiKeyRecord };
export { hashApiKey, apiKeyPrefix, generateApiKey };

/**
 * Project + API-key metadata for the single-tenant Postgres store (ADR 0020).
 *
 * Mirrors the DuckDB metadata helpers, but on a real relational engine: there
 * is still no `org_id` (single-tenant). API keys are stored as SHA-256 hashes
 * (never plaintext). Timestamp columns are read as epoch-ms and surfaced as
 * `Date`, matching the other engines so the store contract is identical.
 */

/** `timestamp` → epoch milliseconds (NULL-preserving). */
const EPOCH_MS = (col: string) => `(EXTRACT(EPOCH FROM ${col}) * 1000)::bigint`;

interface ProjectRow {
  id: string;
  name: string;
  created_at_ms: number;
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, orgId: null, createdAt: new Date(row.created_at_ms) };
}

/** Create a project and return it. */
export async function createProject(client: PostgresClient, name: string): Promise<Project> {
  const rows = await client.query<ProjectRow>(
    `INSERT INTO projects (id, name) VALUES ($1, $2)
     RETURNING id, name, ${EPOCH_MS("created_at")} AS created_at_ms`,
    [randomUUID(), name],
  );
  return toProject(rows[0]!);
}

/** Fetch a project by id, or `null` if it does not exist. */
export async function getProject(client: PostgresClient, id: string): Promise<Project | null> {
  const rows = await client.query<ProjectRow>(
    `SELECT id, name, ${EPOCH_MS("created_at")} AS created_at_ms FROM projects WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toProject(row) : null;
}

interface ApiKeyReadRow {
  id: string;
  project_id: string;
  key_prefix: string;
  created_at_ms: number;
  revoked_at_ms: number | null;
  capability: string | null;
  capabilities: string | null;
  label: string | null;
  rate_limit_max: number | string | null;
  rate_limit_window_ms: number | string | null;
}

/** Columns every API-key read selects, mapped by {@link toApiKeyRecord}. */
const API_KEY_COLS = `id, project_id, key_prefix, ${EPOCH_MS("created_at")} AS created_at_ms,
               ${EPOCH_MS("revoked_at")} AS revoked_at_ms, capability, capabilities, label,
               rate_limit_max, rate_limit_window_ms`;

function toApiKeyRecord(row: ApiKeyReadRow): ApiKeyRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    keyPrefix: row.key_prefix,
    createdAt: new Date(row.created_at_ms),
    revokedAt: row.revoked_at_ms == null ? null : new Date(row.revoked_at_ms),
    capabilities: parseApiKeyCapabilities(row.capabilities, row.capability),
    label: row.label ?? null,
    // `bigint` arrives as a string from node-postgres; `toApiKeyRateLimit` coerces.
    rateLimit: toApiKeyRateLimit(
      row.rate_limit_max == null ? null : Number(row.rate_limit_max),
      row.rate_limit_window_ms == null ? null : Number(row.rate_limit_window_ms),
    ),
  };
}

/**
 * Issue a new API key for a project. Returns both the record and the plaintext
 * key — the plaintext is shown to the caller exactly once and never stored.
 *
 * The legacy singular `capability` column is written alongside the set (its
 * first token) so a collector still running older code keeps resolving the key.
 */
export async function createApiKey(
  client: PostgresClient,
  projectId: string,
  options: CreateApiKeyOptions = {},
): Promise<{ key: string; record: ApiKeyRecord }> {
  const key = generateApiKey();
  const cols = toApiKeyColumns(options);
  const rows = await client.query<ApiKeyReadRow>(
    `INSERT INTO api_keys (id, project_id, key_hash, key_prefix, capability, capabilities,
                           label, rate_limit_max, rate_limit_window_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${API_KEY_COLS}`,
    [
      randomUUID(),
      projectId,
      hashApiKey(key),
      apiKeyPrefix(key),
      cols.capabilities.split(",")[0]!,
      cols.capabilities,
      cols.label,
      cols.rateLimitMax,
      cols.rateLimitWindowMs,
    ],
  );
  return { key, record: toApiKeyRecord(rows[0]!) };
}

/**
 * Resolve a plaintext API key to its (non-revoked) project id, key id,
 * capability set and per-key rate limit, or `null` when the key is unknown or
 * revoked. The collector uses this to authenticate and scope requests at the
 * boundary, and to attribute audit rows to a key without ever logging the key.
 */
export async function resolveApiKey(
  client: PostgresClient,
  plaintext: string,
): Promise<ResolvedApiKey | null> {
  const rows = await client.query<ApiKeyReadRow>(
    `SELECT ${API_KEY_COLS} FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashApiKey(plaintext)],
  );
  const row = rows[0];
  if (!row) return null;
  const record = toApiKeyRecord(row);
  return {
    projectId: record.projectId,
    keyId: record.id,
    capabilities: record.capabilities,
    label: record.label,
    rateLimit: record.rateLimit,
  };
}
