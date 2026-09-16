import { randomUUID } from "node:crypto";
import {
  clampAuditTool,
  mssqlDialect,
  type AgentAuditEntry,
  type AgentAuditInput,
  type AuditQueryOptions,
  type AuditSurface,
} from "@uptimizr/db";
import type { MssqlClient } from "./client.js";

/**
 * Agent audit log for the single-tenant SQL Server store (#309, ADR 0051 §7).
 *
 * Mirrors the DuckDB accessors column-for-column. One row per authenticated
 * request made with a non-dashboard API key; `params` is redacted and bounded by
 * the caller before it arrives, and the subject is the key's **id**, never the
 * key or its hash (ADR 0003).
 */

/** `datetime2` → epoch milliseconds. */
const AT_MS = mssqlDialect.epochMs("at");

/**
 * Epoch-ms → `datetime2(3)`. `DATEADD(millisecond, …)` overflows `int` for an
 * absolute epoch, so the value is split into whole seconds plus a millisecond
 * remainder — both well inside `int` — and added in two steps.
 */
function epochToDatetime(param: string): string {
  return `DATEADD(millisecond, ${param} % 1000, DATEADD(second, ${param} / 1000, CAST(N'1970-01-01' AS datetime2(3))))`;
}

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
export async function recordAudit(client: MssqlClient, entry: AgentAuditInput): Promise<void> {
  await client.query(
    `INSERT INTO dbo.agent_audit (id, project_id, key_id, at, surface, tool_or_path, params,
                                  row_count, duration_ms, status)
     VALUES (@p1, @p2, @p3, ${epochToDatetime("@p4")}, @p5, @p6, @p7, @p8, @p9, @p10)`,
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
  client: MssqlClient,
  projectId: string,
  opts: AuditQueryOptions = {},
): Promise<AgentAuditEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 1000);
  const params: unknown[] = [projectId];
  const where = ["project_id = @p1"];
  if (opts.since != null) {
    params.push(Math.trunc(opts.since));
    where.push(`at >= ${epochToDatetime(`@p${params.length}`)}`);
  }
  if (opts.until != null) {
    params.push(Math.trunc(opts.until));
    where.push(`at < ${epochToDatetime(`@p${params.length}`)}`);
  }
  const rows = await client.query<AuditReadRow>(
    `SELECT TOP (${limit}) id, project_id, key_id, ${AT_MS} AS at_ms, surface, tool_or_path,
            params, row_count, duration_ms, status
       FROM dbo.agent_audit
      WHERE ${where.join(" AND ")}
      ORDER BY at DESC`,
    params,
  );
  return rows.map(toEntry);
}

/**
 * Delete audit rows older than `cutoffMs` (epoch ms). Idempotent, so the
 * collector can run it on a timer.
 */
export async function pruneAudit(client: MssqlClient, cutoffMs: number): Promise<void> {
  await client.query(`DELETE FROM dbo.agent_audit WHERE at < ${epochToDatetime("@p1")}`, [
    Math.trunc(cutoffMs),
  ]);
}
