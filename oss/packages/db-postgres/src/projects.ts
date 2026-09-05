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
  capability: string;
}

/**
 * Issue a new API key for a project. Returns both the record and the plaintext
 * key — the plaintext is shown to the caller exactly once and never stored.
 */
export async function createApiKey(
  client: PostgresClient,
  projectId: string,
  capability: ApiKeyCapability = "query",
): Promise<{ key: string; record: ApiKeyRecord }> {
  const key = generateApiKey();
  const rows = await client.query<ApiKeyReadRow>(
    `INSERT INTO api_keys (id, project_id, key_hash, key_prefix, capability)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id, key_prefix, ${EPOCH_MS("created_at")} AS created_at_ms,
               ${EPOCH_MS("revoked_at")} AS revoked_at_ms, capability`,
    [randomUUID(), projectId, hashApiKey(key), apiKeyPrefix(key), capability],
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
  client: PostgresClient,
  plaintext: string,
): Promise<ResolvedApiKey | null> {
  const rows = await client.query<{ project_id: string; capability: string }>(
    `SELECT project_id, capability FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashApiKey(plaintext)],
  );
  const row = rows[0];
  return row ? { projectId: row.project_id, capability: row.capability as ApiKeyCapability } : null;
}
