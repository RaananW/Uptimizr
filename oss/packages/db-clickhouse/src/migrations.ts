import type { ClickhouseSettings } from "@uptimizr/db";
import { createClickhouseClient, type ClickhouseClient } from "./client.js";

/**
 * Ordered, forward-only ClickHouse migrations for the optional single-tenant
 * scale store (ADR 0020 / ADR 0007). Append new statements; never edit a shipped
 * one. All statements are idempotent (`IF NOT EXISTS`), so {@link migrateClickhouse}
 * is safe to run on every boot.
 *
 * This store is **single-tenant**: there is no `org_id` and no tenant isolation
 * (those live only in the proprietary scale layer). The schema mirrors the DuckDB
 * single-file store column-for-column so the dialect-agnostic aggregations render
 * unchanged and the cross-engine parity suite holds.
 *
 * Table engines:
 * - `events` / `node_samples` are append-only `MergeTree`, partitioned by month
 *   and sorted to match the DuckDB store's indexes.
 * - Metadata tables (`projects`, `api_keys`, `scene_representations`) are
 *   `ReplacingMergeTree`, deduped on read with `FINAL` — the single-tenant analog
 *   of DuckDB's `PRIMARY KEY` / `ON CONFLICT` upserts.
 * - The daily rollups are plain views (pre-grouped by day); the multi-writer
 *   `AggregatingMergeTree` rollups remain the proprietary scale tier.
 */
export const CLICKHOUSE_MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  // --- Events ---------------------------------------------------------------
  // Hot, queryable fields are promoted to columns (mirroring the DuckDB `events`
  // table); the full validated event is preserved in `payload` (String/JSON) so
  // reads stay replay-complete. Vectors are `Array(Float64)`; `ts` is a
  // `DateTime64(3)` treated as UTC (matching the DuckDB store's epoch handling).
  // Promoted numeric columns default to 0 (the aggregations use `nullIf(x, 0)`
  // where 0 is not a meaningful sample), so they need no Nullable wrapper.
  {
    id: "0001_events",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS events (
        project_id        String,
        session_id        String,
        visitor_id        String DEFAULT '',
        event_type        LowCardinality(String),
        ts                DateTime64(3),
        sdk_version       String DEFAULT '',
        url               String DEFAULT '',
        scene_id          String DEFAULT 'default',
        source            LowCardinality(String) DEFAULT 'mouse',
        handedness        String DEFAULT '',
        source_id         String DEFAULT '',
        ray_origin        Array(Float64),
        ray_direction     Array(Float64),
        position          Array(Float64),
        direction         Array(Float64),
        hit_point         Array(Float64),
        screen            Array(Float64),
        mesh              String DEFAULT '',
        fps               Float64 DEFAULT 0,
        visible_ms        Float64 DEFAULT 0,
        centered_ms       Float64 DEFAULT 0,
        screen_fraction   Float64 DEFAULT 0,
        texture_bytes     Float64 DEFAULT 0,
        geometry_bytes    Float64 DEFAULT 0,
        triangles         Float64 DEFAULT 0,
        vertices          Float64 DEFAULT 0,
        js_heap_bytes     Float64 DEFAULT 0,
        cap_from          String DEFAULT '',
        cap_to            String DEFAULT '',
        frame_time_ms     Float64 DEFAULT 0,
        frame_time_p95_ms Float64 DEFAULT 0,
        long_frames       Float64 DEFAULT 0,
        dpr               Float64 DEFAULT 0,
        render_scale      Float64 DEFAULT 0,
        name              String DEFAULT '',
        payload           String,
        inserted_at       DateTime64(3) DEFAULT now64(3)
      )
      ENGINE = MergeTree
      PARTITION BY toYYYYMM(ts)
      ORDER BY (project_id, event_type, ts);
    `,
  },
  // --- Scene-actor transforms (node_transform, ADR 0027) --------------------
  // The highest-cardinality signal gets its own transform-shaped table instead
  // of padding `events` with quaternion/bone columns. Sorted by
  // (project, session, node_id, ts) to mirror the DuckDB index and give cheap
  // per-actor reads. `bone_id` is '' for the Tier-1 node/root tier; `scale` is
  // [] when it never left identity; `child_path` (ADR 0033) is '' for the root
  // and for bone rows.
  {
    id: "0002_node_samples",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS node_samples (
        project_id   String,
        session_id   String,
        ts           DateTime64(3),
        sdk_version  String DEFAULT '',
        scene_id     String DEFAULT 'default',
        node_id      String,
        bone_id      String DEFAULT '',
        position     Array(Float64),
        rotation     Array(Float64),
        scale        Array(Float64),
        child_path   String DEFAULT '',
        inserted_at  DateTime64(3) DEFAULT now64(3)
      )
      ENGINE = MergeTree
      PARTITION BY toYYYYMM(ts)
      ORDER BY (project_id, session_id, node_id, ts);
    `,
  },
  // --- Metadata (re-homed from Postgres for the single-tenant store) ---------
  // Single-tenant: `projects` has no `org_id`. ReplacingMergeTree deduped on read
  // with FINAL. Projects are immutable once created, so no version column is
  // needed — the latest write per id wins.
  {
    id: "0003_projects",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS projects (
        id          String,
        name        String,
        created_at  DateTime64(3) DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree
      ORDER BY id;
    `,
  },
  // API keys are stored as SHA-256 hashes (never plaintext). Deduped on
  // `key_hash`; a `version` column lets a later revocation supersede the row
  // (highest version wins under ReplacingMergeTree).
  {
    id: "0004_api_keys",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS api_keys (
        id          String,
        project_id  String,
        key_hash    String,
        key_prefix  String,
        capability  LowCardinality(String) DEFAULT 'query',
        created_at  DateTime64(3) DEFAULT now64(3),
        revoked_at  Nullable(DateTime64(3)) DEFAULT NULL,
        version     UInt64 DEFAULT 0
      )
      ENGINE = ReplacingMergeTree(version)
      ORDER BY key_hash;
    `,
  },
  // One representation per (project, scene): a developer-supplied label plus an
  // optional engine-agnostic proxy (ADR 0010/0014). Nullable columns mirror the
  // DuckDB store's NULLs so the row mapper round-trips identically. `version`
  // (the upsert's epoch-ms) makes the latest write win under ReplacingMergeTree.
  {
    id: "0005_scene_representations",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS scene_representations (
        project_id     String,
        scene_id       String,
        label          Nullable(String) DEFAULT NULL,
        kind           LowCardinality(String) DEFAULT 'none',
        up_axis        LowCardinality(String) DEFAULT 'y',
        unit_scale     Float64 DEFAULT 1,
        bounds         Nullable(String) DEFAULT NULL,
        proxy          Nullable(String) DEFAULT NULL,
        asset_url      Nullable(String) DEFAULT NULL,
        content_hash   Nullable(String) DEFAULT NULL,
        proxy_version  Nullable(Int64) DEFAULT NULL,
        captured_at    Nullable(DateTime64(3)) DEFAULT NULL,
        updated_at     DateTime64(3) DEFAULT now64(3),
        version        UInt64 DEFAULT 0
      )
      ENGINE = ReplacingMergeTree(version)
      ORDER BY (project_id, scene_id);
    `,
  },
  // --- Rollup views ---------------------------------------------------------
  // Single-tenant rollups are plain views (pre-grouped by day), not
  // AggregatingMergeTree materialized views — those are the scale tier. Column
  // names match the shared read queries (`buildPerfDaily`/`buildEventsDaily`), so
  // each read GROUP BY sees exactly one source row per group and the `-Merge`
  // combinators pass the precomputed value through.
  {
    id: "0006_perf_daily_view",
    sql: /* sql */ `
      CREATE VIEW IF NOT EXISTS perf_daily AS
      SELECT
        project_id,
        toDate(ts) AS day,
        count() AS samples_state,
        avg(fps) AS avg_fps_state,
        min(fps) AS min_fps,
        quantile(0.5)(fps) AS p50_fps_state
      FROM events
      WHERE event_type = 'frame_perf'
      GROUP BY project_id, day;
    `,
  },
  {
    id: "0007_events_daily_view",
    sql: /* sql */ `
      CREATE VIEW IF NOT EXISTS events_daily AS
      SELECT
        project_id,
        event_type,
        toDate(ts) AS day,
        count() AS events
      FROM events
      GROUP BY project_id, event_type, day;
    `,
  },
  // camera_sample projection intrinsics (#22): vertical FOV, viewport aspect, and
  // near-plane distance, mirroring the DuckDB columns so the click-gaze ray
  // aggregation can unproject a flat pointer's `screen` onto the near plane. 0
  // when the sample omitted the intrinsic — the aggregation treats non-positive
  // as "absent" and falls back to the camera position.
  {
    id: "0008_events_camera_intrinsics",
    sql: /* sql */ `
      ALTER TABLE events
        ADD COLUMN IF NOT EXISTS fov    Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS aspect Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS near   Float64 DEFAULT 0;
    `,
  },
];

/**
 * Apply all ClickHouse migrations in order, creating the target database first.
 * Idempotent — safe to run on every boot.
 *
 * `client` is bound to `settings.database`, which may not exist yet, so the
 * `CREATE DATABASE` is issued from a short-lived bootstrap client bound to the
 * always-present `default` database (a server bound to a missing database
 * rejects every statement with `UNKNOWN_DATABASE`). The bound `client` then runs
 * the table/view DDL once the database exists.
 */
export async function migrateClickhouse(
  client: ClickhouseClient,
  settings: ClickhouseSettings,
): Promise<void> {
  const database = assertSafeIdentifier(settings.database);
  const bootstrap = createClickhouseClient({ ...settings, database: "default" });
  try {
    await bootstrap.command(`CREATE DATABASE IF NOT EXISTS ${database}`);
  } finally {
    await bootstrap.close();
  }
  for (const migration of CLICKHOUSE_MIGRATIONS) {
    await client.command(migration.sql);
  }
}

/**
 * Guard the operator-supplied database name before interpolating it into DDL.
 * It comes from `CLICKHOUSE_DATABASE` (trusted env, not request input), but a
 * strict allow-list keeps the `CREATE DATABASE` statement injection-proof.
 */
function assertSafeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid ClickHouse database name ${JSON.stringify(name)}: ` +
        "expected letters, digits and underscores (starting with a letter or underscore).",
    );
  }
  return name;
}
