import { randomUUID } from "node:crypto";
import {
  clampAuditTool,
  type AgentAuditEntry,
  type AgentAuditInput,
  type AuditQueryOptions,
  type AuditSurface,
} from "@uptimizr/db";
import type { ClickhouseClient } from "./client.js";

/**
 * Agent audit log for the single-tenant ClickHouse store (#309, ADR 0051 §7).
 *
 * Mirrors the DuckDB accessors column-for-column. One row per authenticated
 * request made with a non-dashboard API key; `params` is redacted and bounded by
 * the caller before it arrives, and the subject is the key's **id**, never the
 * key or its hash (ADR 0003).
 *
 * The table is append-only (`MergeTree`), so writes are ordinary inserts and the
 * retention sweep is a lightweight delete.
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

const AUDIT_COLS = `id, project_id, key_id, toUnixTimestamp64Milli(at) AS at_ms, surface,
            tool_or_path, params, row_count, duration_ms, status`;

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
export async function recordAudit(client: ClickhouseClient, entry: AgentAuditInput): Promise<void> {
  await client.insert("agent_audit", [
    {
      id: randomUUID(),
      project_id: entry.projectId,
      key_id: entry.keyId,
      // A JSON number inserted into a `DateTime64(3)` is read as raw ticks at
      // that scale — i.e. epoch **milliseconds**, which is exactly what
      // `Date.getTime()` gives. (Dividing to seconds silently stores a time in
      // 1970.) `toUnixTimestamp64Milli` on the read side is the inverse.
      at: entry.at?.getTime() ?? Date.now(),
      surface: entry.surface,
      tool_or_path: clampAuditTool(entry.toolOrPath),
      params: entry.params,
      row_count: entry.rowCount ?? null,
      duration_ms: Math.trunc(entry.durationMs),
      status: Math.trunc(entry.status),
    },
  ]);
}

/** Read a project's audit rows, newest first, within an optional time range. */
export async function listAudit(
  client: ClickhouseClient,
  projectId: string,
  opts: AuditQueryOptions = {},
): Promise<AgentAuditEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 1000);
  const params: Record<string, unknown> = { projectId };
  const where = ["project_id = {projectId:String}"];
  if (opts.since != null) {
    where.push("toUnixTimestamp64Milli(at) >= {since:Int64}");
    params.since = Math.trunc(opts.since);
  }
  if (opts.until != null) {
    where.push("toUnixTimestamp64Milli(at) < {until:Int64}");
    params.until = Math.trunc(opts.until);
  }
  const rows = await client.query<AuditReadRow>(
    `SELECT ${AUDIT_COLS}
       FROM agent_audit
      WHERE ${where.join(" AND ")}
      ORDER BY at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(toEntry);
}

/**
 * Delete audit rows older than `cutoffMs` (epoch ms). ClickHouse's lightweight
 * `DELETE` is asynchronous but idempotent — re-running it over an
 * already-emptied range is a no-op — so the collector can run it on a timer.
 */
export async function pruneAudit(client: ClickhouseClient, cutoffMs: number): Promise<void> {
  await client.command(
    `DELETE FROM agent_audit WHERE toUnixTimestamp64Milli(at) < ${Math.trunc(cutoffMs)}`,
  );
}
