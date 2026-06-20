import { randomUUID } from "node:crypto";
import {
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  type ApiKeyCapability,
  type ApiKeyRecord,
  type Project,
  type ResolvedApiKey,
} from "../metadata.js";
import type { DuckdbClient } from "./client.js";

export type { Project, ApiKeyRecord };
export { hashApiKey, apiKeyPrefix, generateApiKey };

/**
 * Project + API-key metadata for the DuckDB single-file store (ADR 0020).
 *
 * Mirrors the Postgres metadata helpers, but single-tenant: there is no
 * `org_id`. API keys are stored as SHA-256 hashes (never plaintext). Timestamp
 * columns are read as epoch-ms and surfaced as `Date`, matching the Postgres
 * helpers' return types so the store contract is identical across engines.
 */

interface ProjectRow {
  id: string;
  name: string;
  created_at_ms: number;
}

/** Create a project and return it. */
export async function createProject(client: DuckdbClient, name: string): Promise<Project> {
  const id = randomUUID();
  await client.run(`INSERT INTO projects (id, name) VALUES ($id, $name)`, { id, name });
  const rows = await client.all<ProjectRow>(
    `SELECT id, name, epoch_ms(created_at) AS created_at_ms FROM projects WHERE id = $id`,
    { id },
  );
  const row = rows[0]!;
  return { id: row.id, name: row.name, orgId: null, createdAt: new Date(row.created_at_ms) };
}

/** Fetch a project by id, or `null` if it does not exist. */
export async function getProject(client: DuckdbClient, id: string): Promise<Project | null> {
  const rows = await client.all<ProjectRow>(
    `SELECT id, name, epoch_ms(created_at) AS created_at_ms FROM projects WHERE id = $id`,
    { id },
  );
  const row = rows[0];
  return row
    ? { id: row.id, name: row.name, orgId: null, createdAt: new Date(row.created_at_ms) }
    : null;
}

/**
 * Issue a new API key for a project. Returns both the record and the plaintext
 * key — the plaintext is shown to the caller exactly once and never stored.
 */
export async function createApiKey(
  client: DuckdbClient,
  projectId: string,
  capability: ApiKeyCapability = "query",
): Promise<{ key: string; record: ApiKeyRecord }> {
  const key = generateApiKey();
  const id = randomUUID();
  await client.run(
    `INSERT INTO api_keys (id, project_id, key_hash, key_prefix, capability)
     VALUES ($id, $projectId, $keyHash, $keyPrefix, $capability)`,
    { id, projectId, keyHash: hashApiKey(key), keyPrefix: apiKeyPrefix(key), capability },
  );
  const rows = await client.all<{
    id: string;
    project_id: string;
    key_prefix: string;
    created_at_ms: number;
    revoked_at_ms: number | null;
    capability: string;
  }>(
    `SELECT id, project_id, key_prefix, epoch_ms(created_at) AS created_at_ms,
            epoch_ms(revoked_at) AS revoked_at_ms, capability
     FROM api_keys WHERE id = $id`,
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
      revokedAt: row.revoked_at_ms === null ? null : new Date(row.revoked_at_ms),
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
  client: DuckdbClient,
  plaintext: string,
): Promise<ResolvedApiKey | null> {
  const rows = await client.all<{ project_id: string; capability: string }>(
    `SELECT project_id, capability FROM api_keys WHERE key_hash = $keyHash AND revoked_at IS NULL`,
    { keyHash: hashApiKey(plaintext) },
  );
  const row = rows[0];
  return row ? { projectId: row.project_id, capability: row.capability as ApiKeyCapability } : null;
}
