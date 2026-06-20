---
name: add-event-type
description: Add a new analytics event type to Uptimizr end-to-end — Zod schema, SDK emission, Babylon capture, server ingestion/storage, and replay. USE FOR: adding a tracked event, new telemetry signal, new metric, extending the event schema. Trigger phrases: add event type, track a new event, new analytics event, add a metric.
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
   - In `@uptimizr/db`, store the new fields in the **DuckDB** events table — the OSS default
     store (ADR 0020). Promote any hot/queryable field to a column via a forward-only, additive
     migration appended to `DUCKDB_MIGRATIONS`; everything else stays in the JSON `payload`.
   - **Aggregations are dialect-agnostic: define the spec once, emit per dialect.** Add a pure
     `buildX(projectId, opts, dialect)` builder in `@uptimizr/db` that renders a `QuerySpec`
     from the `Dialect` fragments (never hard-code engine SQL). OSS runs it with `duckdbDialect`;
     the optional scale tier runs the _same_ builder with `clickhouseDialect`. Add a `PARITY_CASES`
     entry so both engines stay provably equal.
   - The scale-tier ClickHouse/Postgres column + migration (if the field is promoted there too)
     lives in the separately-licensed scale store, not in `@uptimizr/db`.

4. **Replay (if it affects playback).**
   - If the event changes what the user sees on replay (camera/pointer/pick/mesh), handle it in
     `@uptimizr/replay`'s core + Babylon driver. Replay must not emit analytics events.

5. **Dashboard (optional).**
   - Surface the new signal in `oss/apps/dashboard` if it has a visualization.

6. **Validate.**
   - Run `pnpm lint typecheck build test`. Add an ADR if the change alters semantics or privacy.

## Checklist

- [ ] Schema + union + type exported, tests added in `@uptimizr/schema`
- [ ] Captured/emitted in sdk-core and/or sdk-babylon
- [ ] Stored in the DuckDB events table (additive `DUCKDB_MIGRATIONS` entry if a new column) in `@uptimizr/db`
- [ ] Aggregation defined once as a dialect-agnostic `buildX(..., dialect)` builder with a `PARITY_CASES` entry
- [ ] Handled in replay if it affects playback
- [ ] Storage stays behind the `@uptimizr/db` contracts; privacy rules respected
- [ ] `pnpm lint typecheck build test` green
