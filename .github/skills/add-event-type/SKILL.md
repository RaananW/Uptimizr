---
name: add-event-type
description: Add a new analytics event type to Uptimizr end-to-end — Zod schema, SDK emission, connector capture, server ingestion/storage across the four stores, metric registry, and replay. USE FOR: adding a tracked event, new telemetry signal, new metric, extending the event schema. Trigger phrases: add event type, track a new event, new analytics event, add a metric.
---

# Skill: Add a new analytics event type

Add a new event to Uptimizr so it is defined once and flows correctly through capture,
ingestion, storage, and replay. Event shapes live **only** in `@uptimizr/schema` (ADR: see
`docs/adr`). Keep events replay-complete (ordered, timestamped, `sessionId`-keyed).

## Steps

1. **Define the schema (source of truth).**
   - In `oss/packages/schema`, add a Zod schema for the event and include it in the
     discriminated union on `type`. Export the schema and its `z.infer` type.
   - Reuse the shared envelope (`projectId`, `visitorId`, `sessionId`, `ts`, `sdkVersion`,
     `url`, `pageMeta`). Keep payloads compact (numeric arrays for vectors).
   - Add/extend unit tests validating valid and invalid samples.

2. **Emit it from the SDK.**
   - If it's a generic concern, add support in `@uptimizr/sdk-core`; if it's Babylon-specific
     capture, add an observer in `@uptimizr/babylon` that builds and enqueues the event.
   - Expose any sampling rate as an option (perf vs. fidelity).

3. **Ingest + store it.**
   - The collector validates via the schema automatically; ensure any event-type-specific
     enrichment is handled in `collector-server`.
   - Every event's full payload is stored in the JSON `payload` column. Promote a hot/queryable
     field to a column with a forward-only, additive migration in **all four stores**: DuckDB
     (`DUCKDB_MIGRATIONS` in `@uptimizr/db`), Postgres, SQL Server and ClickHouse (the
     `@uptimizr/db-postgres`, `@uptimizr/db-mssql` and `@uptimizr/db-clickhouse` packages), and
     map it in `toEventRow` and each store's writer. See the `add-migration` skill.
   - **Aggregations are dialect-agnostic: define the spec once, emit per dialect.** Add a pure
     `buildX(projectId, opts, dialect)` builder in `@uptimizr/db` that renders a `QuerySpec`
     from the `Dialect` fragments (never hard-code engine SQL). Each store runs the _same_ builder
     with its own dialect. Add a `PARITY_CASES` entry so every engine stays provably equal.
   - **A new aggregation needs a registry entry.** Add its `build*` name to
     `AGGREGATION_BUILDER_NAMES` and a `MetricDefinition` to `METRIC_REGISTRY` in
     `@uptimizr/metrics`, plus an evaluation case (`CONTRIBUTING.md` §Agent evaluation).

4. **Replay (if it affects playback).**
   - If the event changes what the user sees on replay (camera/pointer/pick/mesh), handle it in
     `@uptimizr/replay`'s core and its engine drivers. Replay must not emit analytics events.

5. **Dashboard (optional).**
   - Surface the new signal in `oss/apps/dashboard` if it has a visualization.

6. **Validate.**
   - Run `pnpm lint typecheck build test`. Add an ADR if the change alters semantics or privacy.

## Checklist

- [ ] Schema + union + type exported, tests added in `@uptimizr/schema`
- [ ] Captured/emitted in sdk-core and/or sdk-babylon
- [ ] A promoted column has an additive migration in all four stores and is mapped in each writer
- [ ] Aggregation defined once as a dialect-agnostic `buildX(..., dialect)` builder with a `PARITY_CASES` entry
- [ ] New aggregation has a `METRIC_REGISTRY` entry and an evaluation case
- [ ] Handled in replay if it affects playback
- [ ] Storage stays behind the `@uptimizr/db` contracts; privacy rules respected
- [ ] `pnpm lint typecheck build test` green
