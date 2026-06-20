---
name: add-migration
description: Add a hand-written SQL migration to @uptimizr/db (ClickHouse events store or Postgres metadata) following the no-framework, forward-only rules of ADR 0007. USE FOR: changing the database schema, adding a column/table/index, a ClickHouse rollup or materialized view, a Postgres metadata table. Trigger phrases: add a migration, write a migration, change the schema, add a column, new table, alter the events table.
---

# Skill: Write a database migration

How to evolve the schema in `@uptimizr/db`. We use **hand-written, ordered SQL migrations with a
tiny in-house runner — no migration framework** (ADR 0007). The same mechanism covers both stores
(ADR 0002): **ClickHouse** (the `events` store + rollups) and **Postgres** (relational metadata).

Authoritative references:

- [docs/adr/0007-migrations.md](../../../docs/adr/0007-migrations.md) — the decision, the rules,
  and the revisit triggers.
- [.github/instructions/database.instructions.md](../../instructions/database.instructions.md) —
  ClickHouse/Postgres conventions.
- ClickHouse:
  [oss/packages/db/src/clickhouse/migrations.ts](../../../oss/packages/db/src/clickhouse/migrations.ts)
  · Postgres:
  [oss/packages/db/src/postgres/migrations.ts](../../../oss/packages/db/src/postgres/migrations.ts).

## 1. The three non-negotiable rules (ADR 0007)

Every migration must be:

1. **Forward-only and additive** — there is no down/rollback and no `schema_migrations` ledger.
   Correctness relies entirely on this.
2. **Idempotent** — guard every statement with `IF NOT EXISTS` (tables, columns, indexes,
   materialized views). The runner re-applies all migrations on every boot, so a non-idempotent
   statement will throw the second time.
3. **Appended, never edited** — a shipped migration is immutable. New schema is always a **new**
   entry with the next `id`. Editing an old entry silently diverges already-migrated databases.

If your change cannot satisfy these (an `ALTER`/`DROP`/backfill that `IF NOT EXISTS` can't make
idempotent, or you need rollback/drift detection), **stop** — that is an ADR 0007 _revisit
trigger_. Raise it: it needs a ledger (and possibly a Postgres-only tool), which is a new ADR, not
a migration.

## 2. Where it goes

Append a `{ id, sql }` object to the right ordered array:

- **ClickHouse** (events, columns on `events`, rollups/MVs) → `CLICKHOUSE_MIGRATIONS` in
  `clickhouse/migrations.ts`.
- **Postgres** (projects, api_keys, scene registry) → `POSTGRES_MIGRATIONS`
  in `postgres/migrations.ts`.

The `id` is `NNNN_snake_case_name`, where `NNNN` is the next zero-padded number **after the last
entry in that array** (each store numbers independently). Ids must stay unique and sorted — the
array order _is_ the apply order. Use the `/* sql */` tag before the template literal (editor SQL
highlighting), matching the surrounding entries.

```ts
// CLICKHOUSE_MIGRATIONS — append at the end
{
  id: "0009_events_my_field",
  sql: /* sql */ `
    ALTER TABLE events
      ADD COLUMN IF NOT EXISTS my_field LowCardinality(String) DEFAULT ''
  `,
},
```

```ts
// POSTGRES_MIGRATIONS — append at the end
{
  id: "0009_my_table",
  sql: /* sql */ `
    CREATE TABLE IF NOT EXISTS my_table (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS my_table_project_id_idx ON my_table (project_id);
  `,
},
```

## 3. Store-specific guidance

**ClickHouse** (performance-critical DDL — write it explicitly, don't let an ORM near it):

- New columns on `events` must be **additive with a sensible `DEFAULT`** so existing rows and the
  insert path (`toEventRow` in `clickhouse/events.ts`) stay valid. Don't reorder or retype shipped
  columns.
- Keep the sort key led by `project_id` (the hot read path); `ORDER BY (project_id, event_type,
ts)` is the existing shape. New aggregate tables partition by month/day to match the read filter.
- Rollups follow the established pattern: an `AggregatingMergeTree`/`SummingMergeTree` table plus a
  `CREATE MATERIALIZED VIEW IF NOT EXISTS … TO <table>`. Query-time aggregation stays the source of
  truth; rollups are an append-only optimization read with the `-Merge`/`sum` helpers in
  `clickhouse/queries.ts`. Note the known `org_id` ingestion gap documented in the file.
- Store vectors as `Array(Float32)` (or separate `Float32` columns), never JSON blobs, for fields
  you query/aggregate.

**Postgres** (relational metadata):

- Use `TEXT` ids, `TIMESTAMPTZ … DEFAULT now()`, and foreign keys with `ON DELETE CASCADE`
  consistent with the existing tables. Add a covering index for foreign keys you filter on.
- API keys store **only hashes**, never plaintext (ADR 0003).

## 4. Tests — what is expected

The migration arrays have a **static, no-database** well-formed test:
[oss/packages/db/src/\_\_tests\_\_/migrations.test.ts](../../../oss/packages/db/src/__tests__/migrations.test.ts).
It asserts ids are unique + sorted and that every statement contains `IF NOT EXISTS`. Your new
entry must keep those green. When the change has externally visible intent (a tenant column, a
rollup, a spatial column), **add an assertion** that the specific migration exists and has the key
clause — mirror the existing `org_id` / `scene_id` / `input_source` checks.

Real ClickHouse/Postgres integration (actually applying DDL) runs against `infra/docker`, **not**
in unit tests. Apply locally to prove it works:

```bash
# bring up the stack first (see the run-local-stack skill), then:
pnpm --filter @uptimizr/db migrate   # applies ClickHouse + Postgres in order
```

Because the runner re-applies everything, run it **twice** — the second run proves idempotency.

## 5. Wire the new schema through

A column nobody reads is dead weight. After the migration, update the code that uses it in the
same change: the insert path (`clickhouse/events.ts` `toEventRow`) for a new ingested field, the
`QuerySpec` builders in `clickhouse/queries.ts` and the matching collector query route + Zod
params for a new filter/aggregate, and the Postgres accessors (`postgres/*.ts`) for metadata. If
the field originates from an analytics event, its shape belongs in `@uptimizr/schema` first (see
the `add-event-type` skill) — never redefine event fields in the db layer.

## 6. Validate & finish

Run the focused tests, then the full gate, and record an ADR if the change alters semantics or
privacy (per the `work-on-issue` skill):

```bash
pnpm --filter @uptimizr/db test
pnpm lint typecheck build test
```
