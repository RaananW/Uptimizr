import { MSSQL_BIN_COLLATION, mssqlDialect } from "@uptimizr/db";
import type { MssqlClient } from "./client.js";

/**
 * Ordered, forward-only SQL Server migrations for the optional single-tenant
 * relational store (ADR 0020 / ADR 0007, #85). Append new statements; never
 * edit a shipped one. All statements are idempotent (`IF OBJECT_ID(…) IS NULL`
 * / `CREATE OR ALTER`), so {@link migrateMssql} is safe to run on every boot —
 * and, because several collector instances may share one database, the whole
 * run is serialized behind a transaction-scoped application lock
 * (`sp_getapplock`). DDL is transactional in SQL Server, so a run either
 * applies fully or not at all.
 *
 * This store is **single-tenant**: there is no `org_id` and no tenant isolation
 * (those live only in the proprietary scale layer). The schema mirrors the
 * DuckDB single-file store column-for-column so the dialect-agnostic
 * aggregations render unchanged and the cross-engine parity suite holds. All
 * objects live in `dbo` (unqualified names in the shared SQL resolve through
 * the login's default schema).
 *
 * T-SQL choices (the fit gaps of issue #85):
 * - **No array type.** Vector columns are JSON number arrays in `nvarchar`
 *   (`'[x,y,z]'`, default `'[]'`); the shared SQL's `position[1]` becomes
 *   `JSON_VALUE(position, '$[0]')` at execution time (`toTsql` in
 *   `@uptimizr/db`). The full validated event is preserved in a JSON `payload`
 *   so reads stay replay-complete.
 * - Strings use the binary collation `Latin1_General_100_BIN2`, so equality,
 *   grouping and ordering are case-sensitive / code-point ordered like DuckDB
 *   and Postgres (SQL Server's default collation is case-insensitive).
 * - `ts` is `datetime2(3)` holding wall-clock UTC (never `datetimeoffset`), so
 *   ordering, date truncation and epoch extraction are identical to the other
 *   engines.
 * - Promoted numeric columns are `float` defaulting to 0 (the aggregations use
 *   `nullIf(x, 0)` where 0 is not a meaningful sample), so integer `avg`
 *   truncation never applies to them.
 * - **No aggregate percentile.** `dbo.uptimizr_quantile` sorts the values that
 *   `mssqlDialect.quantile` packs with `STRING_AGG` and computes the exact
 *   type-7 interpolated quantile.
 * - **No MergeTree-style rollups**: the daily aggregates are plain views
 *   recomputed at query time (`perf_daily`, `events_daily`), acceptable at the
 *   single-tenant scale this store targets.
 * - Indexes cover the two access paths the aggregations use: the per-type range
 *   scan `(project_id, event_type, ts)` and the per-session nearest-row lookup
 *   `(project_id, session_id, ts)` that the ASOF emulation (`APPLY … TOP 1`)
 *   relies on.
 */

const C = `COLLATE ${MSSQL_BIN_COLLATION}`;
/** Short identifier-like text (ids, enums, names used as index keys). */
const KEY = `nvarchar(255) ${C}`;
/** Unbounded text (URLs, mesh names, JSON) — never truncates an ingest. */
const TEXT = `nvarchar(max) ${C}`;
/** JSON number array (vector) column. */
const VECTOR = `nvarchar(max) NOT NULL DEFAULT N'[]'`;

export const MSSQL_MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  // --- Quantile helper (see module doc) ------------------------------------
  // `@packed` is the group's non-NULL values (any order) as a comma-separated
  // list of round-trippable float literals; the function sorts them. Type-7
  // interpolation: h = (n - 1) * q; v[floor h] + (h - floor h) * (v[ceil h] -
  // v[floor h]) — the definition DuckDB's `quantile_cont` and Postgres'
  // `percentile_cont` share. NULL for an empty group.
  {
    id: "0000_quantile_function",
    sql: /* sql */ `
      CREATE OR ALTER FUNCTION dbo.uptimizr_quantile(@packed varchar(max), @q float)
      RETURNS float
      WITH SCHEMABINDING
      AS
      BEGIN
        IF @packed IS NULL RETURN NULL;
        DECLARE @n int = (SELECT count(*) FROM STRING_SPLIT(@packed, ','));
        IF @n = 0 RETURN NULL;
        DECLARE @h float = (@n - 1) * @q;
        DECLARE @lo int = FLOOR(@h);
        DECLARE @hi int = CEILING(@h);
        DECLARE @vlo float, @vhi float;
        SELECT
          @vlo = MAX(CASE WHEN rn = @lo + 1 THEN v END),
          @vhi = MAX(CASE WHEN rn = @hi + 1 THEN v END)
        FROM (
          SELECT CAST(value AS float) AS v,
                 ROW_NUMBER() OVER (ORDER BY CAST(value AS float)) AS rn
          FROM STRING_SPLIT(@packed, ',')
        ) AS sorted
        WHERE rn IN (@lo + 1, @hi + 1);
        RETURN @vlo + (@h - @lo) * (@vhi - @vlo);
      END
    `,
  },
  // --- Events ---------------------------------------------------------------
  {
    id: "0001_events",
    sql: /* sql */ `
      IF OBJECT_ID(N'dbo.events', N'U') IS NULL
      CREATE TABLE dbo.events (
        project_id        ${KEY} NOT NULL,
        session_id        ${KEY} NOT NULL,
        visitor_id        ${KEY} NOT NULL DEFAULT N'',
        event_type        ${KEY} NOT NULL,
        ts                datetime2(3) NOT NULL,
        sdk_version       ${KEY} NOT NULL DEFAULT N'',
        url               ${TEXT} NOT NULL DEFAULT N'',
        scene_id          ${KEY} NOT NULL DEFAULT N'default',
        source            ${KEY} NOT NULL DEFAULT N'mouse',
        handedness        ${KEY} NOT NULL DEFAULT N'',
        source_id         ${KEY} NOT NULL DEFAULT N'',
        ray_origin        ${VECTOR},
        ray_direction     ${VECTOR},
        position          ${VECTOR},
        direction         ${VECTOR},
        hit_point         ${VECTOR},
        screen            ${VECTOR},
        mesh              ${TEXT} NOT NULL DEFAULT N'',
        fps               float NOT NULL DEFAULT 0,
        visible_ms        float NOT NULL DEFAULT 0,
        centered_ms       float NOT NULL DEFAULT 0,
        screen_fraction   float NOT NULL DEFAULT 0,
        texture_bytes     float NOT NULL DEFAULT 0,
        geometry_bytes    float NOT NULL DEFAULT 0,
        triangles         float NOT NULL DEFAULT 0,
        vertices          float NOT NULL DEFAULT 0,
        js_heap_bytes     float NOT NULL DEFAULT 0,
        cap_from          ${KEY} NOT NULL DEFAULT N'',
        cap_to            ${KEY} NOT NULL DEFAULT N'',
        frame_time_ms     float NOT NULL DEFAULT 0,
        frame_time_p95_ms float NOT NULL DEFAULT 0,
        long_frames       float NOT NULL DEFAULT 0,
        dpr               float NOT NULL DEFAULT 0,
        render_scale      float NOT NULL DEFAULT 0,
        fov               float NOT NULL DEFAULT 0,
        aspect            float NOT NULL DEFAULT 0,
        near              float NOT NULL DEFAULT 0,
        name              ${TEXT} NOT NULL DEFAULT N'',
        payload           nvarchar(max) NOT NULL,
        inserted_at       datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
      );
    `,
  },
  {
    id: "0002_events_type_ts_idx",
    sql: /* sql */ `
      IF NOT EXISTS (SELECT 1 FROM sys.indexes
                     WHERE name = N'events_project_type_ts_idx' AND object_id = OBJECT_ID(N'dbo.events'))
      CREATE INDEX events_project_type_ts_idx ON dbo.events (project_id, event_type, ts);
    `,
  },
  // Per-session ordered access: session reads (replay) and the nearest-row
  // ASOF emulation's correlated lookup (`WHERE session_id = … AND ts <= …
  // ORDER BY ts DESC`, `TOP 1`) both walk this index.
  {
    id: "0003_events_session_ts_idx",
    sql: /* sql */ `
      IF NOT EXISTS (SELECT 1 FROM sys.indexes
                     WHERE name = N'events_project_session_ts_idx' AND object_id = OBJECT_ID(N'dbo.events'))
      CREATE INDEX events_project_session_ts_idx ON dbo.events (project_id, session_id, ts);
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
      IF OBJECT_ID(N'dbo.node_samples', N'U') IS NULL
      CREATE TABLE dbo.node_samples (
        project_id   ${KEY} NOT NULL,
        session_id   ${KEY} NOT NULL,
        ts           datetime2(3) NOT NULL,
        sdk_version  ${KEY} NOT NULL DEFAULT N'',
        scene_id     ${KEY} NOT NULL DEFAULT N'default',
        node_id      ${KEY} NOT NULL,
        bone_id      ${KEY} NOT NULL DEFAULT N'',
        position     ${VECTOR},
        rotation     ${VECTOR},
        scale        ${VECTOR},
        child_path   ${TEXT} NOT NULL DEFAULT N'',
        inserted_at  datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
      );
    `,
  },
  {
    id: "0005_node_samples_idx",
    sql: /* sql */ `
      IF NOT EXISTS (SELECT 1 FROM sys.indexes
                     WHERE name = N'node_samples_session_node_ts_idx' AND object_id = OBJECT_ID(N'dbo.node_samples'))
      CREATE INDEX node_samples_session_node_ts_idx
        ON dbo.node_samples (project_id, session_id, node_id, ts);
    `,
  },
  // --- Metadata (single-tenant: `projects` has no `org_id`) ------------------
  {
    id: "0006_projects",
    sql: /* sql */ `
      IF OBJECT_ID(N'dbo.projects', N'U') IS NULL
      CREATE TABLE dbo.projects (
        id          ${KEY} NOT NULL PRIMARY KEY,
        name        ${TEXT} NOT NULL,
        created_at  datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
      );
    `,
  },
  // API keys are stored as SHA-256 hashes (never plaintext). `capability`
  // scopes a key to `ingest` | `query` (enforced at the read boundaries).
  {
    id: "0007_api_keys",
    sql: /* sql */ `
      IF OBJECT_ID(N'dbo.api_keys', N'U') IS NULL
      CREATE TABLE dbo.api_keys (
        id          ${KEY} NOT NULL PRIMARY KEY,
        project_id  ${KEY} NOT NULL,
        key_hash    ${KEY} NOT NULL UNIQUE,
        key_prefix  ${KEY} NOT NULL,
        capability  ${KEY} NOT NULL DEFAULT N'query',
        created_at  datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        revoked_at  datetime2(3) NULL
      );
    `,
  },
  // One representation per (project, scene): a developer-supplied label plus an
  // optional engine-agnostic proxy (ADR 0010/0014). `bounds`/`proxy` are JSON
  // text parsed by the row mapper, exactly as in the DuckDB store.
  {
    id: "0008_scene_representations",
    sql: /* sql */ `
      IF OBJECT_ID(N'dbo.scene_representations', N'U') IS NULL
      CREATE TABLE dbo.scene_representations (
        project_id     ${KEY} NOT NULL,
        scene_id       ${KEY} NOT NULL,
        label          ${TEXT} NULL,
        kind           ${KEY} NOT NULL DEFAULT N'none',
        up_axis        ${KEY} NOT NULL DEFAULT N'y',
        unit_scale     float NOT NULL DEFAULT 1,
        bounds         nvarchar(max) NULL,
        proxy          nvarchar(max) NULL,
        asset_url      ${TEXT} NULL,
        content_hash   ${KEY} NULL,
        proxy_version  int NULL,
        captured_at    datetime2(3) NULL,
        updated_at     datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
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
      CREATE OR ALTER VIEW dbo.perf_daily AS
      SELECT
        project_id,
        CAST(ts AS date) AS day,
        count(*) AS samples_state,
        avg(fps) AS avg_fps_state,
        min(fps) AS min_fps,
        ${mssqlDialect.quantile("fps", 0.5)} AS p50_fps_state
      FROM dbo.events
      WHERE event_type = N'frame_perf'
      GROUP BY project_id, CAST(ts AS date);
    `,
  },
  {
    id: "0010_events_daily_view",
    sql: /* sql */ `
      CREATE OR ALTER VIEW dbo.events_daily AS
      SELECT
        project_id,
        event_type,
        CAST(ts AS date) AS day,
        count(*) AS events
      FROM dbo.events
      GROUP BY project_id, event_type, CAST(ts AS date);
    `,
  },
  // --- Agent-scoped keys (#309, ADR 0051 §7) --------------------------------
  // The singular `capability` column becomes a capability *set*, stored as a
  // canonical comma-separated token list in a plain text column (no JSON type
  // needed on any engine). Forward-only and additive: `0007_api_keys` is
  // untouched and its column keeps feeding the read path as the fallback for any
  // row this backfill has not reached. T-SQL has no `ADD COLUMN IF NOT EXISTS`,
  // so each column is guarded with the equivalent `COL_LENGTH(...) IS NULL`.
  {
    id: "0011_api_keys_capabilities",
    sql: /* sql */ `
      IF COL_LENGTH(N'dbo.api_keys', N'capabilities') IS NULL
        ALTER TABLE dbo.api_keys ADD capabilities ${TEXT} NULL;
      IF COL_LENGTH(N'dbo.api_keys', N'label') IS NULL
        ALTER TABLE dbo.api_keys ADD label ${TEXT} NULL;
      IF COL_LENGTH(N'dbo.api_keys', N'rate_limit_max') IS NULL
        ALTER TABLE dbo.api_keys ADD rate_limit_max bigint NULL;
      IF COL_LENGTH(N'dbo.api_keys', N'rate_limit_window_ms') IS NULL
        ALTER TABLE dbo.api_keys ADD rate_limit_window_ms bigint NULL;
    `,
  },
  // Idempotent backfill: promote each legacy single capability to a one-element
  // set, exactly once. Guarded on NULL/'' so re-running on every boot is a no-op
  // after the first (and never clobbers a key minted with a set). The statement
  // is deferred with EXEC because the columns above are added in the same batch.
  {
    id: "0012_api_keys_capabilities_backfill",
    sql: /* sql */ `
      IF COL_LENGTH(N'dbo.api_keys', N'capabilities') IS NOT NULL
        EXEC(N'
          UPDATE dbo.api_keys
             SET capabilities = coalesce(nullif(capability, N''''), N''query'')
           WHERE capabilities IS NULL OR capabilities = N'''';
        ');
    `,
  },
  // Agent audit log: one row per authenticated request made with a non-dashboard
  // key. `params` is bounded and redacted before it is written (never the key);
  // rows expire after AUDIT_RETENTION_DAYS. Metadata, not events.
  {
    id: "0013_agent_audit",
    sql: /* sql */ `
      IF OBJECT_ID(N'dbo.agent_audit', N'U') IS NULL
      CREATE TABLE dbo.agent_audit (
        id            ${KEY} NOT NULL PRIMARY KEY,
        project_id    ${KEY} NOT NULL,
        key_id        ${KEY} NOT NULL,
        at            datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        surface       ${KEY} NOT NULL DEFAULT N'http',
        tool_or_path  ${KEY} NOT NULL,
        params        ${TEXT} NOT NULL DEFAULT N'',
        row_count     bigint NULL,
        duration_ms   bigint NOT NULL DEFAULT 0,
        status        int NOT NULL DEFAULT 200
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes
                      WHERE name = N'agent_audit_project_at_idx'
                        AND object_id = OBJECT_ID(N'dbo.agent_audit'))
        CREATE INDEX agent_audit_project_at_idx ON dbo.agent_audit (project_id, at DESC);
    `,
  },
  // Scene regions (ADR 0051 §2 / sketch §B.2): developer-named, labelled boxes
  // that extend the scene registry (ADR 0014) with a vocabulary for *where*.
  // One row per region, keyed by (project, scene, region); regions may overlap.
  // `bounds` is JSON text parsed by the row mapper, exactly as in the other stores.
  // The key is declared NONCLUSTERED: SQL Server caps a *clustered* index key at
  // 900 bytes, and three `nvarchar(255)` columns exceed that (a nonclustered key
  // may reach 1700 bytes). Region reads are tiny point lookups, so a heap with a
  // nonclustered unique key is the right shape anyway.
  {
    id: "0014_scene_regions",
    sql: /* sql */ `
      IF OBJECT_ID(N'dbo.scene_regions', N'U') IS NULL
      CREATE TABLE dbo.scene_regions (
        project_id   ${KEY} NOT NULL,
        scene_id     ${KEY} NOT NULL,
        region_id    ${KEY} NOT NULL,
        label        ${TEXT} NOT NULL,
        description  ${TEXT} NULL,
        bounds       nvarchar(max) NOT NULL,
        updated_at   datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        PRIMARY KEY NONCLUSTERED (project_id, scene_id, region_id)
      );
    `,
  },
  // Conditional subscriptions (#311, ADR 0051 §6 / sketch §F.1–F.2). One row per
  // standing question; the declaration lives in a JSON `config` column and the
  // scalars beside it are exactly what the store filters (`project_id`,
  // `enabled`), orders (`created_at`) or updates (`last_fired_at`, `failures`).
  //
  // `webhook_secret` is the shared HMAC key: deliberately NOT hashed — a one-way
  // digest cannot sign an outbound body — and never selected by any read path
  // other than `getWebhookSecret`.
  //
  // Like `scene_regions`, the key is `NONCLUSTERED`: the index-key size limit
  // (1700 bytes) applies to the clustered key, and a heap with a nonclustered
  // key is the right shape for point lookups anyway.
  {
    id: "0015_subscriptions",
    sql: /* sql */ `
      IF OBJECT_ID(N'dbo.subscriptions', N'U') IS NULL
      CREATE TABLE dbo.subscriptions (
        id             ${KEY} NOT NULL,
        project_id     ${KEY} NOT NULL,
        name           ${TEXT} NOT NULL,
        metric         ${KEY} NOT NULL,
        config         nvarchar(max) NOT NULL,
        webhook_secret ${TEXT} NULL,
        enabled        bit NOT NULL DEFAULT 1,
        created_at     datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at     datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        last_fired_at  datetime2(3) NULL,
        last_error     ${TEXT} NULL,
        failures       bigint NOT NULL DEFAULT 0,
        PRIMARY KEY NONCLUSTERED (id)
      );
    `,
  },
  {
    id: "0016_subscriptions_idx",
    sql: /* sql */ `
      IF NOT EXISTS (SELECT 1 FROM sys.indexes
                      WHERE name = N'subscriptions_project_idx'
                        AND object_id = OBJECT_ID(N'dbo.subscriptions'))
      CREATE INDEX subscriptions_project_idx
        ON dbo.subscriptions (project_id, created_at);
    `,
  },
  // The bounded firing log: `{ subscriptionId, at, payload }`, last 100 per
  // subscription, trimmed in the same transaction as the insert.
  {
    id: "0017_subscription_events",
    sql: /* sql */ `
      IF OBJECT_ID(N'dbo.subscription_events', N'U') IS NULL
      CREATE TABLE dbo.subscription_events (
        id              ${KEY} NOT NULL,
        subscription_id ${KEY} NOT NULL,
        project_id      ${KEY} NOT NULL,
        at              datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        payload         nvarchar(max) NOT NULL,
        PRIMARY KEY NONCLUSTERED (id)
      );
    `,
  },
  {
    id: "0018_subscription_events_idx",
    sql: /* sql */ `
      IF NOT EXISTS (SELECT 1 FROM sys.indexes
                      WHERE name = N'subscription_events_sub_at_idx'
                        AND object_id = OBJECT_ID(N'dbo.subscription_events'))
      CREATE INDEX subscription_events_sub_at_idx
        ON dbo.subscription_events (subscription_id, at DESC);
    `,
  },
];

/**
 * Apply all SQL Server migrations in order. Idempotent — safe to run on every
 * boot, concurrently from multiple instances (serialized behind an application
 * lock; a lock wait beyond two minutes fails the boot instead of hanging).
 *
 * The target database must exist: `ensureMssqlDatabase` creates it on first
 * boot when the login is allowed to, otherwise create it up front.
 */
export async function migrateMssql(client: MssqlClient): Promise<void> {
  await client.transaction(async (tx) => {
    await tx.command(
      `DECLARE @lock int;
       EXEC @lock = sp_getapplock @Resource = N'uptimizr:migrations', @LockMode = N'Exclusive',
                                  @LockOwner = N'Transaction', @LockTimeout = 120000;
       IF @lock < 0 THROW 50000, N'Could not acquire the uptimizr migration lock', 1;`,
    );
    for (const migration of MSSQL_MIGRATIONS) {
      await tx.command(migration.sql);
    }
  });
}
