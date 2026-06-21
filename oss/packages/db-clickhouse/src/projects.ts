import { randomUUID } from "node:crypto";
import {
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  type ApiKeyCapability,
  type ApiKeyRecord,
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
  capability: string;
}

/**
 * Issue a new API key for a project. Returns both the record and the plaintext
 * key — the plaintext is shown to the caller exactly once and never stored.
 */
export async function createApiKey(
  client: ClickhouseClient,
  projectId: string,
  capability: ApiKeyCapability = "query",
): Promise<{ key: string; record: ApiKeyRecord }> {
  const key = generateApiKey();
  const id = randomUUID();
  await client.insert("api_keys", [
    {
      id,
      project_id: projectId,
      key_hash: hashApiKey(key),
      key_prefix: apiKeyPrefix(key),
      capability,
      version: Date.now(),
    },
  ]);
  const rows = await client.query<ApiKeyReadRow>(
    `SELECT id, project_id, key_prefix,
            toUnixTimestamp64Milli(created_at) AS created_at_ms,
            toUnixTimestamp64Milli(revoked_at) AS revoked_at_ms, capability
     FROM api_keys FINAL WHERE id = {id:String}`,
    { id },
  );
  const row = rows[0]!;
  return {
    key,
    record: {
      id: row.id,
      projectId: row.project_id,
      keyPrefix: row.key_prefix,
      createdAt: new Date(row.created_at_ms),
      revokedAt: row.revoked_at_ms == null ? null : new Date(row.revoked_at_ms),
      capability: row.capability as ApiKeyCapability,
    },
  };
}

/**
 * Resolve a plaintext API key to its (non-revoked) project id and capability, or
 * `null` when the key is unknown or revoked. The collector uses this to
 * authenticate and scope read requests at the boundary.
 */
export async function resolveApiKey(
  client: ClickhouseClient,
  plaintext: string,
): Promise<ResolvedApiKey | null> {
  const rows = await client.query<{ project_id: string; capability: string }>(
    `SELECT project_id, capability FROM api_keys FINAL
     WHERE key_hash = {keyHash:String} AND revoked_at IS NULL`,
    { keyHash: hashApiKey(plaintext) },
  );
  const row = rows[0];
  return row ? { projectId: row.project_id, capability: row.capability as ApiKeyCapability } : null;
}
