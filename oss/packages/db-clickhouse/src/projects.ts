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
import type { ClickhouseClient } from "./client.js";

export type { Project, ApiKeyRecord };
export { hashApiKey, apiKeyPrefix, generateApiKey };

/**
 * Project + API-key metadata for the single-tenant ClickHouse store (ADR 0020).
 *
 * Mirrors the DuckDB / Postgres metadata helpers, but single-tenant: there is no
 * `org_id`. API keys are stored as SHA-256 hashes (never plaintext). The tables
 * are `ReplacingMergeTree`, so reads use `FINAL` to see the deduplicated latest
 * row. Timestamp columns are read as epoch-ms and surfaced as `Date`, matching
 * the other engines so the store contract is identical.
 */

interface ProjectRow {
  id: string;
  name: string;
  created_at_ms: number;
}

/** Create a project and return it. */
export async function createProject(client: ClickhouseClient, name: string): Promise<Project> {
  const id = randomUUID();
  await client.insert("projects", [{ id, name }]);
  const rows = await client.query<ProjectRow>(
    `SELECT id, name, toUnixTimestamp64Milli(created_at) AS created_at_ms
     FROM projects FINAL WHERE id = {id:String}`,
    { id },
  );
  const row = rows[0]!;
  return { id: row.id, name: row.name, orgId: null, createdAt: new Date(row.created_at_ms) };
}

/** Fetch a project by id, or `null` if it does not exist. */
export async function getProject(client: ClickhouseClient, id: string): Promise<Project | null> {
  const rows = await client.query<ProjectRow>(
    `SELECT id, name, toUnixTimestamp64Milli(created_at) AS created_at_ms
     FROM projects FINAL WHERE id = {id:String}`,
    { id },
  );
  const row = rows[0];
  return row
    ? { id: row.id, name: row.name, orgId: null, createdAt: new Date(row.created_at_ms) }
    : null;
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
  rate_limit_max: number | null;
  rate_limit_window_ms: number | null;
}

/** Columns every API-key read selects, mapped by {@link toApiKeyRecord}. */
const API_KEY_COLS = `id, project_id, key_prefix,
            toUnixTimestamp64Milli(created_at) AS created_at_ms,
            toUnixTimestamp64Milli(revoked_at) AS revoked_at_ms, capability, capabilities,
            label, rate_limit_max, rate_limit_window_ms`;

function toApiKeyRecord(row: ApiKeyReadRow): ApiKeyRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    keyPrefix: row.key_prefix,
    createdAt: new Date(row.created_at_ms),
    revokedAt: row.revoked_at_ms == null ? null : new Date(row.revoked_at_ms),
    capabilities: parseApiKeyCapabilities(row.capabilities, row.capability),
    label: row.label ?? null,
    rateLimit: toApiKeyRateLimit(row.rate_limit_max, row.rate_limit_window_ms),
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
  client: ClickhouseClient,
  projectId: string,
  options: CreateApiKeyOptions = {},
): Promise<{ key: string; record: ApiKeyRecord }> {
  const key = generateApiKey();
  const id = randomUUID();
  const cols = toApiKeyColumns(options);
  await client.insert("api_keys", [
    {
      id,
      project_id: projectId,
      key_hash: hashApiKey(key),
      key_prefix: apiKeyPrefix(key),
      capability: cols.capabilities.split(",")[0]!,
      capabilities: cols.capabilities,
      label: cols.label,
      rate_limit_max: cols.rateLimitMax,
      rate_limit_window_ms: cols.rateLimitWindowMs,
      version: Date.now(),
    },
  ]);
  const rows = await client.query<ApiKeyReadRow>(
    `SELECT ${API_KEY_COLS} FROM api_keys FINAL WHERE id = {id:String}`,
    { id },
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
  client: ClickhouseClient,
  plaintext: string,
): Promise<ResolvedApiKey | null> {
  const rows = await client.query<ApiKeyReadRow>(
    `SELECT ${API_KEY_COLS} FROM api_keys FINAL
     WHERE key_hash = {keyHash:String} AND revoked_at IS NULL`,
    { keyHash: hashApiKey(plaintext) },
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
