import type { PostgresSettings } from "@uptimizr/db";
import { assertSafeIdentifier, type PostgresClient } from "./client.js";

/**
 * Ordered, forward-only Postgres migrations for the optional single-tenant
 * relational store (ADR 0020 / ADR 0007, #84). Append new statements; never edit
 * a shipped one. All statements are idempotent (`IF NOT EXISTS` /
 * `CREATE OR REPLACE VIEW`), so {@link migratePostgres} is safe to run on every
 * boot — and, because several collector instances may share one database, the
 * whole run is serialized behind a transaction-scoped advisory lock.
 *
 * This store is **single-tenant**: there is no `org_id` and no tenant isolation
 * (those live only in the proprietary scale layer). The schema mirrors the
 * DuckDB single-file store column-for-column so the dialect-agnostic
 * aggregations render unchanged and the cross-engine parity suite holds.
 *
 * Row-store choices (the parts the SQL Server port, #85, mirrors 1:1):
 * - Vectors are native `double precision[]` (1-indexed like DuckDB/ClickHouse,
 *   so `position[1]` in the shared SQL is untouched); the full validated event
 *   is preserved in a `jsonb` `payload` so reads stay replay-complete.
 * - `ts` is a naive `timestamp` holding wall-clock UTC (never `timestamptz`), so
 *   ordering, `::date` truncation and epoch extraction are session-TZ-independent
 *   and identical to the other engines.
 * - Promoted numeric columns default to 0 (the aggregations use `nullIf(x, 0)`
 *   where 0 is not a meaningful sample), so they need no NULL handling.
 * - There are **no MergeTree-style rollups**: the daily aggregates are plain
 *   views recomputed at query time (`perf_daily`, `events_daily`), acceptable at
 *   the single-tenant scale this store targets. The multi-writer rollups remain
 *   the scale tier.
 * - Indexes cover the two access paths the aggregations use: the per-type range
 *   scan `(project_id, event_type, ts)` and the per-session nearest-row lookup
 *   `(project_id, session_id, ts)` that the ASOF emulation (`LATERAL … LIMIT 1`)
 *   relies on.
 */
export const POSTGRES_MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  // --- Events ---------------------------------------------------------------
  {
    id: "0001_events",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS events (
        project_id        text NOT NULL,
        session_id        text NOT NULL,
        visitor_id        text NOT NULL DEFAULT '',
        event_type        text NOT NULL,
        ts                timestamp NOT NULL,
        sdk_version       text NOT NULL DEFAULT '',
        url               text NOT NULL DEFAULT '',
        scene_id          text NOT NULL DEFAULT 'default',
        source            text NOT NULL DEFAULT 'mouse',
        handedness        text NOT NULL DEFAULT '',
        source_id         text NOT NULL DEFAULT '',
        ray_origin        double precision[] NOT NULL DEFAULT '{}',
        ray_direction     double precision[] NOT NULL DEFAULT '{}',
        position          double precision[] NOT NULL DEFAULT '{}',
        direction         double precision[] NOT NULL DEFAULT '{}',
        hit_point         double precision[] NOT NULL DEFAULT '{}',
        screen            double precision[] NOT NULL DEFAULT '{}',
        mesh              text NOT NULL DEFAULT '',
        fps               double precision NOT NULL DEFAULT 0,
        visible_ms        double precision NOT NULL DEFAULT 0,
        centered_ms       double precision NOT NULL DEFAULT 0,
        screen_fraction   double precision NOT NULL DEFAULT 0,
        texture_bytes     double precision NOT NULL DEFAULT 0,
        geometry_bytes    double precision NOT NULL DEFAULT 0,
        triangles         double precision NOT NULL DEFAULT 0,
        vertices          double precision NOT NULL DEFAULT 0,
        js_heap_bytes     double precision NOT NULL DEFAULT 0,
        cap_from          text NOT NULL DEFAULT '',
        cap_to            text NOT NULL DEFAULT '',
        frame_time_ms     double precision NOT NULL DEFAULT 0,
        frame_time_p95_ms double precision NOT NULL DEFAULT 0,
        long_frames       double precision NOT NULL DEFAULT 0,
        dpr               double precision NOT NULL DEFAULT 0,
        render_scale      double precision NOT NULL DEFAULT 0,
        fov               double precision NOT NULL DEFAULT 0,
        aspect            double precision NOT NULL DEFAULT 0,
        near              double precision NOT NULL DEFAULT 0,
        name              text NOT NULL DEFAULT '',
        payload           jsonb NOT NULL,
        inserted_at       timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      );
    `,
  },
  {
    id: "0002_events_type_ts_idx",
    sql: /* sql */ `
      CREATE INDEX IF NOT EXISTS events_project_type_ts_idx
        ON events (project_id, event_type, ts);
    `,
  },
  // Per-session ordered access: session reads (replay) and the nearest-row
  // ASOF emulation's correlated lookup (`WHERE session_id = … AND ts <= …
  // ORDER BY ts DESC LIMIT 1`) both walk this index.
  {
    id: "0003_events_session_ts_idx",
    sql: /* sql */ `
      CREATE INDEX IF NOT EXISTS events_project_session_ts_idx
        ON events (project_id, session_id, ts);
    `,
  },
  // --- Scene-actor transforms (node_transform, ADR 0027) --------------------
  // The highest-cardinality signal gets its own transform-shaped table instead
  // of padding `events` with quaternion/bone columns. `bone_id` is '' for the
  // Tier-1 node/root tier; `scale` is empty when it never left identity;
  // `child_path` (ADR 0033) is '' for the root and for bone rows.
  {
    id: "0004_node_samples",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS node_samples (
        project_id   text NOT NULL,
        session_id   text NOT NULL,
        ts           timestamp NOT NULL,
        sdk_version  text NOT NULL DEFAULT '',
        scene_id     text NOT NULL DEFAULT 'default',
        node_id      text NOT NULL,
        bone_id      text NOT NULL DEFAULT '',
        position     double precision[] NOT NULL DEFAULT '{}',
        rotation     double precision[] NOT NULL DEFAULT '{}',
        scale        double precision[] NOT NULL DEFAULT '{}',
        child_path   text NOT NULL DEFAULT '',
        inserted_at  timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      );
    `,
  },
  {
    id: "0005_node_samples_idx",
    sql: /* sql */ `
      CREATE INDEX IF NOT EXISTS node_samples_session_node_ts_idx
        ON node_samples (project_id, session_id, node_id, ts);
    `,
  },
  // --- Metadata (single-tenant: `projects` has no `org_id`) ------------------
  {
    id: "0006_projects",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS projects (
        id          text PRIMARY KEY,
        name        text NOT NULL,
        created_at  timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      );
    `,
  },
  // API keys are stored as SHA-256 hashes (never plaintext). `capability`
  // scopes a key to `ingest` | `query` (enforced at the read boundaries).
  {
    id: "0007_api_keys",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS api_keys (
        id          text PRIMARY KEY,
        project_id  text NOT NULL,
        key_hash    text NOT NULL UNIQUE,
        key_prefix  text NOT NULL,
        capability  text NOT NULL DEFAULT 'query',
        created_at  timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        revoked_at  timestamp
      );
    `,
  },
  // One representation per (project, scene): a developer-supplied label plus an
  // optional engine-agnostic proxy (ADR 0010/0014). `bounds`/`proxy` are JSON
  // text parsed by the row mapper, exactly as in the DuckDB store.
  {
    id: "0008_scene_representations",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS scene_representations (
        project_id     text NOT NULL,
        scene_id       text NOT NULL,
        label          text,
        kind           text NOT NULL DEFAULT 'none',
        up_axis        text NOT NULL DEFAULT 'y',
        unit_scale     double precision NOT NULL DEFAULT 1,
        bounds         text,
        proxy          text,
        asset_url      text,
        content_hash   text,
        proxy_version  integer,
        captured_at    timestamp,
        updated_at     timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        PRIMARY KEY (project_id, scene_id)
      );
    `,
  },
  // --- Query-time rollups ---------------------------------------------------
  // No incremental materialized views: the daily rollups read by
  // `buildPerfDaily`/`buildEventsDaily` are plain views that pre-group by
  // `(project_id, …, day)` and recompute on every read. Column names match the
  // shared read queries, so each read GROUP BY sees exactly one source row per
  // group and the `-Merge` combinators pass the precomputed value through.
  {
    id: "0009_perf_daily_view",
    sql: /* sql */ `
      CREATE OR REPLACE VIEW perf_daily AS
      SELECT
        project_id,
        CAST(ts AS DATE) AS day,
        count(*) AS samples_state,
        avg(fps) AS avg_fps_state,
        min(fps) AS min_fps,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY fps) AS p50_fps_state
      FROM events
      WHERE event_type = 'frame_perf'
      GROUP BY project_id, CAST(ts AS DATE);
    `,
  },
  {
    id: "0010_events_daily_view",
    sql: /* sql */ `
      CREATE OR REPLACE VIEW events_daily AS
      SELECT
        project_id,
        event_type,
        CAST(ts AS DATE) AS day,
        count(*) AS events
      FROM events
      GROUP BY project_id, event_type, CAST(ts AS DATE);
    `,
  },
];

/**
 * Stable advisory-lock key that serializes concurrent boots of several
 * collector instances against one database (DDL is transactional in Postgres,
 * so the migrations either all apply or none do).
 */
const MIGRATION_LOCK_KEY = 0x7570_7469; // "upti"

/**
 * Apply all Postgres migrations in order, creating the configured schema first.
 * Idempotent — safe to run on every boot, concurrently from multiple instances.
 *
 * The database named in `settings.url` must already exist (creating databases
 * needs a connection to another database and elevated privileges — the
 * docker-compose service and most managed providers create it for you).
 */
export async function migratePostgres(
  client: PostgresClient,
  settings: PostgresSettings,
): Promise<void> {
  const schema = assertSafeIdentifier(settings.schema);
  await client.transaction(async (tx) => {
    await tx.command(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    await tx.command(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    for (const migration of POSTGRES_MIGRATIONS) {
      await tx.command(migration.sql);
    }
  });
}
