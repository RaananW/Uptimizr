import type { DuckdbClient } from "./client.js";

/**
 * Ordered, forward-only DuckDB migrations for the OSS single-file store
 * (ADR 0020 / ADR 0007). Append new statements; never edit a shipped one. All
 * statements are idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE VIEW`), so
 * {@link migrateDuckdb} is safe to run on every boot.
 *
 * This store is **single-tenant**: there is no `org_id` and no tenant isolation
 * (those live only in the proprietary scale layer). Events and metadata share
 * one file so a self-hosted collector needs no external services.
 */
export const DUCKDB_MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  // --- Events ---------------------------------------------------------------
  // Hot, queryable fields are promoted to columns (mirroring the ClickHouse
  // `events` table); the full validated event is preserved in `payload` (JSON)
  // so reads stay replay-complete. Vectors are `DOUBLE[]`; `ts` is a naive-UTC
  // TIMESTAMP (epoch handling matches the ClickHouse store).
  {
    id: "0001_events",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS events (
        project_id    VARCHAR NOT NULL,
        session_id    VARCHAR NOT NULL,
        visitor_id    VARCHAR NOT NULL DEFAULT '',
        event_type    VARCHAR NOT NULL,
        ts            TIMESTAMP NOT NULL,
        sdk_version   VARCHAR NOT NULL DEFAULT '',
        url           VARCHAR NOT NULL DEFAULT '',
        scene_id      VARCHAR NOT NULL DEFAULT 'default',
        source        VARCHAR NOT NULL DEFAULT 'mouse',
        handedness    VARCHAR NOT NULL DEFAULT '',
        source_id     VARCHAR NOT NULL DEFAULT '',
        ray_origin    DOUBLE[],
        ray_direction DOUBLE[],
        position      DOUBLE[],
        direction     DOUBLE[],
        hit_point     DOUBLE[],
        screen        DOUBLE[],
        mesh          VARCHAR NOT NULL DEFAULT '',
        fps           DOUBLE NOT NULL DEFAULT 0,
        name          VARCHAR NOT NULL DEFAULT '',
        payload       VARCHAR NOT NULL,
        inserted_at   TIMESTAMP NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "0002_events_idx",
    sql: /* sql */ `
      CREATE INDEX IF NOT EXISTS events_project_type_ts_idx
        ON events (project_id, event_type, ts);
    `,
  },
  // --- Metadata (re-homed from Postgres for the single-file store) -----------
  // Single-tenant: `projects` has no `org_id`. API keys are stored as SHA-256
  // hashes (never plaintext), consistent with the Postgres store.
  {
    id: "0003_projects",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS projects (
        id          VARCHAR PRIMARY KEY,
        name        VARCHAR NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "0004_api_keys",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS api_keys (
        id          VARCHAR PRIMARY KEY,
        project_id  VARCHAR NOT NULL,
        key_hash    VARCHAR NOT NULL UNIQUE,
        key_prefix  VARCHAR NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT now(),
        revoked_at  TIMESTAMP
      );
    `,
  },
  // One representation per (project, scene): a developer-supplied label plus an
  // optional engine-agnostic proxy (ADR 0010/0014). `bounds`/`proxy` are stored
  // as JSON text (parsed by the row mapper).
  {
    id: "0005_scene_representations",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS scene_representations (
        project_id     VARCHAR NOT NULL,
        scene_id       VARCHAR NOT NULL,
        label          VARCHAR,
        kind           VARCHAR NOT NULL DEFAULT 'none',
        up_axis        VARCHAR NOT NULL DEFAULT 'y',
        unit_scale     DOUBLE NOT NULL DEFAULT 1,
        bounds         VARCHAR,
        proxy          VARCHAR,
        asset_url      VARCHAR,
        content_hash   VARCHAR,
        proxy_version  INTEGER,
        captured_at    TIMESTAMP,
        updated_at     TIMESTAMP NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, scene_id)
      );
    `,
  },
  // --- Rollup views ---------------------------------------------------------
  // DuckDB has no incremental materialized views, so the daily rollups read by
  // `buildPerfDaily`/`buildEventsDaily` are plain views that pre-group by
  // `(project_id, …, day)`. Column names match the ClickHouse rollup tables so
  // the shared read queries work unchanged; each read GROUP BY then sees exactly
  // one source row per group (its `-Merge` combinators pass the value through).
  {
    id: "0006_perf_daily_view",
    sql: /* sql */ `
      CREATE OR REPLACE VIEW perf_daily AS
      SELECT
        project_id,
        CAST(ts AS DATE) AS day,
        count(*) AS samples_state,
        avg(fps) AS avg_fps_state,
        min(fps) AS min_fps,
        quantile_cont(fps, 0.5) AS p50_fps_state
      FROM events
      WHERE event_type = 'frame_perf'
      GROUP BY project_id, day;
    `,
  },
  {
    id: "0007_events_daily_view",
    sql: /* sql */ `
      CREATE OR REPLACE VIEW events_daily AS
      SELECT
        project_id,
        event_type,
        CAST(ts AS DATE) AS day,
        count(*) AS events
      FROM events
      GROUP BY project_id, event_type, day;
    `,
  },
  // --- mesh_visibility dwell metrics (#37) ----------------------------------
  // Promote the per-object attention fields to columns for the dwell
  // aggregation (mirroring `fps` for `frame_perf`). The appender always writes a
  // value (0 on non-visibility events); the full event stays in `payload`.
  // Forward-only, additive, idempotent. No DEFAULT/NOT NULL: DuckDB's ALTER ADD
  // COLUMN rejects NOT NULL and a stored DEFAULT trips a reopen crash, so the
  // columns are plain nullable DOUBLE (SUM/MAX ignore the NULLs on old rows).
  {
    id: "0008_events_visible_ms",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS visible_ms DOUBLE;
    `,
  },
  {
    id: "0009_events_centered_ms",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS centered_ms DOUBLE;
    `,
  },
  {
    id: "0010_events_screen_fraction",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS screen_fraction DOUBLE;
    `,
  },
  // resource_sample (#44) GPU / memory footprint metrics. Same additive,
  // nullable-DOUBLE pattern: old rows read NULL, which SUM/AVG/MAX ignore.
  {
    id: "0011_events_texture_bytes",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS texture_bytes DOUBLE;
    `,
  },
  {
    id: "0012_events_geometry_bytes",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS geometry_bytes DOUBLE;
    `,
  },
  {
    id: "0013_events_triangles",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS triangles DOUBLE;
    `,
  },
  {
    id: "0014_events_vertices",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS vertices DOUBLE;
    `,
  },
  {
    id: "0015_events_js_heap_bytes",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS js_heap_bytes DOUBLE;
    `,
  },
  // capability_change (#49) fallback/recovery transition. `kind` reuses the
  // shared `name` column (same precedent as compile_stall's phase); the
  // from/to capability tokens get their own additive, nullable VARCHAR columns.
  // `reason` stays in the JSON payload only (free-form, not a group key).
  {
    id: "0016_events_cap_from",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS cap_from VARCHAR;
    `,
  },
  {
    id: "0017_events_cap_to",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS cap_to VARCHAR;
    `,
  },
  // --- Scene-actor transforms (node_transform, ADR 0027) --------------------
  // `node_transform` is the highest-cardinality signal (actors × rate, × bones
  // for Tier 2), so it gets its own transform-shaped table instead of bloating
  // the wide `events` table with quaternion/bone columns that are null for every
  // other type. Rows are reconstructed back into replay-complete `node_transform`
  // events on read and merged with the `events` stream by `ts` (ADR 0027 §8/§9).
  // Ordered by (project, session, node_id, ts) to mirror the ClickHouse scale-tier
  // sort key and give cheap per-actor reads. `bone_id` is '' for the Tier-1
  // node/root tier; `scale` is empty when it never left identity.
  {
    id: "0018_node_samples",
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS node_samples (
        project_id   VARCHAR NOT NULL,
        session_id   VARCHAR NOT NULL,
        ts           TIMESTAMP NOT NULL,
        sdk_version  VARCHAR NOT NULL DEFAULT '',
        scene_id     VARCHAR NOT NULL DEFAULT 'default',
        node_id      VARCHAR NOT NULL,
        bone_id      VARCHAR NOT NULL DEFAULT '',
        position     DOUBLE[],
        rotation     DOUBLE[],
        scale        DOUBLE[],
        inserted_at  TIMESTAMP NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "0019_node_samples_idx",
    sql: /* sql */ `
      CREATE INDEX IF NOT EXISTS node_samples_session_node_ts_idx
        ON node_samples (project_id, session_id, node_id, ts);
    `,
  },
  // --- frame_perf percentile / jank / resolution detail (#80) ---------------
  // Promote the percentile, jank, and resolution fields so the per-session perf
  // aggregations (ADR 0028) read columns instead of JSON. Same additive,
  // nullable-DOUBLE pattern as the resource columns: old rows read NULL (ignored
  // by SUM/AVG/MAX); new non-frame_perf rows read 0 (filtered out by event_type).
  {
    id: "0020_events_frame_time_ms",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS frame_time_ms DOUBLE;
    `,
  },
  {
    id: "0021_events_frame_time_p95_ms",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS frame_time_p95_ms DOUBLE;
    `,
  },
  {
    id: "0022_events_long_frames",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS long_frames DOUBLE;
    `,
  },
  {
    id: "0023_events_dpr",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS dpr DOUBLE;
    `,
  },
  {
    id: "0024_events_render_scale",
    sql: /* sql */ `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS render_scale DOUBLE;
    `,
  },
  // --- node_transform Tier-1 subtree children (ADR 0033) --------------------
  // `child_path` is the descendant's engine node path relative to `node_id`
  // (e.g. 'Body/Arm_L/Hand'); '' for the declared root and for Tier-2 bone rows.
  // Added after `inserted_at` (physically last), so the appender binds it last.
  // DuckDB's `ALTER TABLE ADD COLUMN` rejects NOT NULL/DEFAULT constraints, so
  // the column is plain nullable VARCHAR; the appender always writes '' (never
  // null) for new rows and the reader treats any falsy value as "no childPath".
  {
    id: "0025_node_samples_child_path",
    sql: /* sql */ `
      ALTER TABLE node_samples ADD COLUMN IF NOT EXISTS child_path VARCHAR;
    `,
  },
  {
    id: "0026_node_samples_child_idx",
    sql: /* sql */ `
      CREATE INDEX IF NOT EXISTS node_samples_session_node_child_ts_idx
        ON node_samples (project_id, session_id, node_id, child_path, ts);
    `,
  },
  // API-key capability scope (`ingest` | `query`). Public ingestion is keyless,
  // so issued keys are for reads — existing keys are grandfathered to `query`
  // and the column default is `query`. Enforced at the read boundaries
  // (query + live token exchange).
  {
    id: "0027_api_keys_capability",
    sql: /* sql */ `
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS capability VARCHAR DEFAULT 'query';
    `,
  },
];

/**
 * Apply all DuckDB migrations in order. Idempotent — safe to run on every boot.
 */
export async function migrateDuckdb(client: DuckdbClient): Promise<void> {
  for (const migration of DUCKDB_MIGRATIONS) {
    await client.run(migration.sql);
  }
  // Flush the WAL into the main file. `ALTER TABLE ... ADD COLUMN` entries crash
  // DuckDB's WAL replay on the next open, so checkpointing here keeps a
  // file-backed store reopenable after a schema change. No-op for `:memory:`.
  await client.run("CHECKPOINT;");
}
