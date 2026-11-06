---
name: add-migration
description: Add a hand-written SQL migration to Uptimizr's stores (DuckDB in @uptimizr/db, plus the optional Postgres, SQL Server and ClickHouse packages) following the no-framework, forward-only rules of ADR 0007. USE FOR: changing the database schema, adding a column/table/index, a metadata table. Trigger phrases: add a migration, write a migration, change the schema, add a column, new table, alter the events table.
---

# Skill: Write a database migration

How to evolve the schema. We use **hand-written, ordered SQL migrations with a tiny in-house runner
— no migration framework** (ADR 0007). There are four stores, each holding events **and** metadata
(ADR 0020), and each owns its own migration array:

| Store      | Array                   | File                                                                                                  |
| ---------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| DuckDB     | `DUCKDB_MIGRATIONS`     | [oss/packages/db/src/duckdb/migrations.ts](../../../oss/packages/db/src/duckdb/migrations.ts)         |
| Postgres   | `POSTGRES_MIGRATIONS`   | [oss/packages/db-postgres/src/migrations.ts](../../../oss/packages/db-postgres/src/migrations.ts)     |
| SQL Server | `MSSQL_MIGRATIONS`      | [oss/packages/db-mssql/src/migrations.ts](../../../oss/packages/db-mssql/src/migrations.ts)           |
| ClickHouse | `CLICKHOUSE_MIGRATIONS` | [oss/packages/db-clickhouse/src/migrations.ts](../../../oss/packages/db-clickhouse/src/migrations.ts) |

Authoritative references:

- [docs/adr/0007-migrations.md](../../../docs/adr/0007-migrations.md) — the decision, the rules,
  and the revisit triggers.
- [.github/instructions/database.instructions.md](../../instructions/database.instructions.md) —
  store conventions.

## 1. The three non-negotiable rules (ADR 0007)

Every migration must be:

1. **Forward-only and additive** — there is no down/rollback and no `schema_migrations` ledger.
   Correctness relies entirely on this.
2. **Idempotent** — guard every statement. Each runner re-applies all of its migrations on every
   boot, so an unguarded statement will throw the second time.
3. **Appended, never edited** — a shipped migration is immutable. New schema is always a **new**
   entry with the next `id`. Editing an old entry silently diverges already-migrated databases.

If your change cannot satisfy these (an `ALTER`/`DROP`/backfill that a guard can't make idempotent,
or you need rollback/drift detection), **stop** — that is an ADR 0007 _revisit trigger_. Raise it:
it needs a ledger, which is a new ADR, not a migration.

## 2. Where it goes

The shared aggregations render against the same column names on every engine, so a schema change
goes in **all four arrays** in the same PR. Append a `{ id, sql }` object to each.

The `id` is `NNNN_snake_case_name`, where `NNNN` is the next zero-padded number **after the last
entry in that array** (each store numbers independently, so one change has four different numbers).
Ids must stay unique and sorted — the array order _is_ the apply order. Use the `/* sql */` tag
before the template literal, matching the surrounding entries.

```ts
// DUCKDB_MIGRATIONS, POSTGRES_MIGRATIONS and CLICKHOUSE_MIGRATIONS (types differ per engine)
{
  id: "0050_events_my_field",
  sql: /* sql */ `
    ALTER TABLE events ADD COLUMN IF NOT EXISTS my_field VARCHAR NOT NULL DEFAULT '';
  `,
},
```

```ts
// MSSQL_MIGRATIONS — T-SQL has no `ADD COLUMN IF NOT EXISTS`
{
  id: "0024_events_my_field",
  sql: /* sql */ `
    IF COL_LENGTH(N'dbo.events', N'my_field') IS NULL
      ALTER TABLE dbo.events ADD my_field ${TEXT} NOT NULL DEFAULT '';
  `,
},
```

## 3. Store-specific guidance

- **All stores:** match the column types and guards of the surrounding entries. New columns on
  `events` need a sensible default so existing rows and the insert path stay valid. Don't reorder
  or retype shipped columns. API keys store **only hashes**, never plaintext (ADR 0003).
- **DuckDB:** `IF NOT EXISTS` for DDL, `CREATE OR REPLACE` for views, a `WHERE` guard for a data
  backfill.
- **Postgres:** the same guards. The whole run is one transaction behind an advisory lock, so
  several collector instances can boot at once.
- **SQL Server:** `IF OBJECT_ID` (tables), `IF NOT EXISTS` over `sys.indexes`, `IF COL_LENGTH`
  (columns), `CREATE OR ALTER` (views and functions). Vectors are JSON arrays in `nvarchar`, not an
  array type. The run is one transaction behind an application lock.
- **ClickHouse:** `IF NOT EXISTS`. `events` is an append-only `MergeTree`; metadata tables are
  `ReplacingMergeTree`, deduped on read with `FINAL`. Daily rollups are plain views, not
  materialized views.

## 4. Tests — what is expected

Each array has a **static, no-database** well-formed test asserting unique, sorted ids and a guard
on every statement:

- [oss/packages/db/src/\_\_tests\_\_/migrations.test.ts](../../../oss/packages/db/src/__tests__/migrations.test.ts)
- `oss/packages/db-postgres/src/__tests__/dialect.test.ts`,
  `oss/packages/db-mssql/src/__tests__/dialect.test.ts` and
  `oss/packages/db-clickhouse/src/__tests__/dialect.test.ts` (their `*_MIGRATIONS` blocks)

Your new entries must keep those green. When the change has externally visible intent, **add an
assertion** that the specific migration exists and has the key clause, mirroring the existing
`0011_api_keys_capabilities` checks.

Applying the DDL for real happens outside unit tests:

```bash
pnpm --filter @uptimizr/db migrate   # DuckDB; run it twice, the second run proves idempotency

# Optional stores, against infra/docker (see the run-local-stack skill):
pnpm stack:up
pnpm test:parity:postgres
pnpm test:parity:mssql
pnpm test:parity:clickhouse
```

## 5. Wire the new schema through

A column nobody reads is dead weight. After the migration, update the code that uses it in the
same change:

- the shared event mapper `toEventRow` in `oss/packages/db/src/events.ts`, and each store's writer
  (`oss/packages/db/src/duckdb/events.ts`, `oss/packages/db-*/src/events.ts`);
- the `build*` query builders in `oss/packages/db/src/query/aggregations.ts`, and the matching
  collector query route + Zod params for a new filter/aggregate;
- each store's metadata accessors for a metadata table.

If the field originates from an analytics event, its shape belongs in `@uptimizr/schema` first (see
the `add-event-type` skill) — never redefine event fields in the db layer.

## 6. Validate & finish

Run the focused tests, then the full gate, and record an ADR if the change alters semantics or
privacy (per the `work-on-issue` skill):

```bash
pnpm --filter @uptimizr/db test
pnpm lint typecheck build test
```
