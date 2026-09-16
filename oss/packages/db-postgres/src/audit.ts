import { randomUUID } from "node:crypto";
import {
  clampAuditTool,
  type AgentAuditEntry,
  type AgentAuditInput,
  type AuditQueryOptions,
  type AuditSurface,
} from "@uptimizr/db";
import type { PostgresClient } from "./client.js";

/**
 * Agent audit log for the single-tenant Postgres store (#309, ADR 0051 §7).
 *
 * Mirrors the DuckDB accessors column-for-column. One row per authenticated
 * request made with a non-dashboard API key; `params` is redacted and bounded by
 * the caller before it arrives, and the subject is the key's **id**, never the
 * key or its hash (ADR 0003).
 */

/** `timestamp` → epoch milliseconds. */
const AT_MS = `(EXTRACT(EPOCH FROM at) * 1000)::bigint`;

interface AuditReadRow {
  id: string;
  project_id: string;
  key_id: string;
  at_ms: number | string;
  surface: string;
  tool_or_path: string;
  params: string;
  row_count: number | string | null;
  duration_ms: number | string;
  status: number | string;
}

function toEntry(row: AuditReadRow): AgentAuditEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    keyId: row.key_id,
    at: new Date(Number(row.at_ms)),
    surface: row.surface as AuditSurface,
    toolOrPath: row.tool_or_path,
    params: row.params,
    rowCount: row.row_count == null ? null : Number(row.row_count),
    durationMs: Number(row.duration_ms),
    status: Number(row.status),
  };
}

/** Append one audit row. */
export async function recordAudit(client: PostgresClient, entry: AgentAuditInput): Promise<void> {
  await client.query(
    `INSERT INTO agent_audit (id, project_id, key_id, at, surface, tool_or_path, params,
                              row_count, duration_ms, status)
     VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000) AT TIME ZONE 'utc',
             $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      entry.projectId,
      entry.keyId,
      entry.at?.getTime() ?? Date.now(),
      entry.surface,
      clampAuditTool(entry.toolOrPath),
      entry.params,
      entry.rowCount ?? null,
      Math.trunc(entry.durationMs),
      Math.trunc(entry.status),
    ],
  );
}

/** Read a project's audit rows, newest first, within an optional time range. */
export async function listAudit(
  client: PostgresClient,
  projectId: string,
  opts: AuditQueryOptions = {},
): Promise<AgentAuditEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 1000);
  const params: unknown[] = [projectId];
  const where = ["project_id = $1"];
  if (opts.since != null) {
    params.push(Math.trunc(opts.since));
    where.push(`at >= to_timestamp($${params.length}::double precision / 1000) AT TIME ZONE 'utc'`);
  }
  if (opts.until != null) {
    params.push(Math.trunc(opts.until));
    where.push(`at < to_timestamp($${params.length}::double precision / 1000) AT TIME ZONE 'utc'`);
  }
  const rows = await client.query<AuditReadRow>(
    `SELECT id, project_id, key_id, ${AT_MS} AS at_ms, surface, tool_or_path, params,
            row_count, duration_ms, status
       FROM agent_audit
      WHERE ${where.join(" AND ")}
      ORDER BY at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(toEntry);
}

/**
 * Delete audit rows older than `cutoffMs` (epoch ms). Idempotent, so the
 * collector can run it on a timer.
 */
export async function pruneAudit(client: PostgresClient, cutoffMs: number): Promise<void> {
  await client.query(
    `DELETE FROM agent_audit WHERE at < to_timestamp($1::double precision / 1000) AT TIME ZONE 'utc'`,
    [Math.trunc(cutoffMs)],
  );
}
