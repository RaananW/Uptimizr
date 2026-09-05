import { randomUUID } from "node:crypto";
import {
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  mssqlDialect,
  type ApiKeyCapability,
  type ApiKeyRecord,
  type Project,
  type ResolvedApiKey,
} from "@uptimizr/db";
import type { MssqlClient } from "./client.js";

export type { Project, ApiKeyRecord };
export { hashApiKey, apiKeyPrefix, generateApiKey };

/**
 * Project + API-key metadata for the single-tenant SQL Server store (ADR 0020).
 *
 * Mirrors the DuckDB metadata helpers, but on a real relational engine: there
 * is still no `org_id` (single-tenant). API keys are stored as SHA-256 hashes
 * (never plaintext). Timestamp columns are read as epoch-ms and surfaced as
 * `Date`, matching the other engines so the store contract is identical.
 */

/** `datetime2` → epoch milliseconds (NULL-preserving). */
const EPOCH_MS = (col: string) => mssqlDialect.epochMs(col);

interface ProjectRow {
  id: string;
  name: string;
  created_at_ms: number;
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, orgId: null, createdAt: new Date(row.created_at_ms) };
}

const PROJECT_COLS = `id, name, ${EPOCH_MS("created_at")} AS created_at_ms`;

/** Create a project and return it. */
export async function createProject(client: MssqlClient, name: string): Promise<Project> {
  const id = randomUUID();
  await client.query(`INSERT INTO dbo.projects (id, name) VALUES (@p1, @p2)`, [id, name]);
  const rows = await client.query<ProjectRow>(
    `SELECT ${PROJECT_COLS} FROM dbo.projects WHERE id = @p1`,
    [id],
  );
  return toProject(rows[0]!);
}

/** Fetch a project by id, or `null` if it does not exist. */
export async function getProject(client: MssqlClient, id: string): Promise<Project | null> {
  const rows = await client.query<ProjectRow>(
    `SELECT ${PROJECT_COLS} FROM dbo.projects WHERE id = @p1`,
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
  client: MssqlClient,
  projectId: string,
  capability: ApiKeyCapability = "query",
): Promise<{ key: string; record: ApiKeyRecord }> {
  const key = generateApiKey();
  const id = randomUUID();
  await client.query(
    `INSERT INTO dbo.api_keys (id, project_id, key_hash, key_prefix, capability)
     VALUES (@p1, @p2, @p3, @p4, @p5)`,
    [id, projectId, hashApiKey(key), apiKeyPrefix(key), capability],
  );
  const rows = await client.query<ApiKeyReadRow>(
    `SELECT id, project_id, key_prefix, ${EPOCH_MS("created_at")} AS created_at_ms,
            ${EPOCH_MS("revoked_at")} AS revoked_at_ms, capability
     FROM dbo.api_keys WHERE id = @p1`,
    [id],
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
  client: MssqlClient,
  plaintext: string,
): Promise<ResolvedApiKey | null> {
  const rows = await client.query<{ project_id: string; capability: string }>(
    `SELECT project_id, capability FROM dbo.api_keys WHERE key_hash = @p1 AND revoked_at IS NULL`,
    [hashApiKey(plaintext)],
  );
  const row = rows[0];
  return row ? { projectId: row.project_id, capability: row.capability as ApiKeyCapability } : null;
}
