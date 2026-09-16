import { randomUUID } from "node:crypto";
import {
  clampAuditTool,
  type AgentAuditEntry,
  type AgentAuditInput,
  type AuditQueryOptions,
  type AuditSurface,
} from "../metadata.js";
import type { DuckdbClient } from "./client.js";

/**
 * Agent audit log for the DuckDB single-file store (#309, ADR 0051 §7).
 *
 * One row per authenticated request made with a non-dashboard API key: which key
 * asked, for what, how long it took and how big the answer was. It is *metadata*,
 * not events — no event type is added and `@uptimizr/schema` is untouched.
 *
 * Privacy: `params` is redacted and bounded by the caller
 * (`serializeAuditParams`) before it reaches here, and the subject is the key's
 * **id**, never the key or its hash (ADR 0003).
 */

interface AuditReadRow {
  id: string;
  project_id: string;
  key_id: string;
  at_ms: number;
  surface: string;
  tool_or_path: string;
  params: string;
  row_count: number | null;
  duration_ms: number;
  status: number;
}

const AUDIT_COLS = `id, project_id, key_id, epoch_ms("at") AS at_ms, surface, tool_or_path,
            params, row_count, duration_ms, status`;

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
export async function recordAudit(client: DuckdbClient, entry: AgentAuditInput): Promise<void> {
  await client.run(
    `INSERT INTO agent_audit (id, project_id, key_id, "at", surface, tool_or_path, params,
                              row_count, duration_ms, status)
     VALUES ($id, $projectId, $keyId, make_timestamp($atUs), $surface, $toolOrPath, $params,
             CAST($rowCount AS BIGINT), $durationMs, $status)`,
    {
      id: randomUUID(),
      projectId: entry.projectId,
      keyId: entry.keyId,
      atUs: (entry.at?.getTime() ?? Date.now()) * 1000,
      surface: entry.surface,
      toolOrPath: clampAuditTool(entry.toolOrPath),
      params: entry.params,
      rowCount: entry.rowCount ?? null,
      durationMs: Math.trunc(entry.durationMs),
      status: Math.trunc(entry.status),
    },
  );
}

/** Read a project's audit rows, newest first, within an optional time range. */
export async function listAudit(
  client: DuckdbClient,
  projectId: string,
  opts: AuditQueryOptions = {},
): Promise<AgentAuditEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 1000);
  const params: Record<string, unknown> = { projectId };
  const where = ["project_id = $projectId"];
  if (opts.since != null) {
    where.push(`"at" >= make_timestamp($since)`);
    params.since = Math.trunc(opts.since) * 1000;
  }
  if (opts.until != null) {
    where.push(`"at" < make_timestamp($until)`);
    params.until = Math.trunc(opts.until) * 1000;
  }
  const rows = await client.all<AuditReadRow>(
    `SELECT ${AUDIT_COLS}
       FROM agent_audit
      WHERE ${where.join(" AND ")}
      ORDER BY "at" DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(toEntry);
}

/**
 * Delete audit rows older than `cutoffMs` (epoch ms). Idempotent — deleting an
 * already-empty range is a no-op — so the collector can run it on a timer.
 * Returns nothing; the caller only needs to know it did not throw.
 */
export async function pruneAudit(client: DuckdbClient, cutoffMs: number): Promise<void> {
  await client.run(`DELETE FROM agent_audit WHERE "at" < make_timestamp($cutoff)`, {
    cutoff: Math.trunc(cutoffMs) * 1000,
  });
}
