# ADR 0052: Bounded event retention, and what the raw-session flag really does

- **Status:** Accepted
- **Date:** 2026-11-06
- **Deciders:** Project owner, engineering
- **Supersedes:** the retention statement of [ADR 0003](./0003-privacy-model.md) ("When off, only
  aggregate-friendly data is retained") and the "Same retention rules" bullet of
  [ADR 0013](./0013-error-capture-privacy.md). The rest of both ADRs stands.

## Context

ADR 0003 says that with `ENABLE_RAW_SESSION_RETENTION` off, "only aggregate-friendly data is
retained", and ADR 0013 repeats it for `runtime_error`. Neither has been true:

- The flag gates **reading**. It decides whether the raw per-session endpoints answer; together
  with the `query:raw` capability it controls API access. It has never controlled storage.
- `POST /api/v1/collect` always calls `store.insertEvents`. Every row keeps the full event in
  `payload`, whatever the flag says. `node_transform` events are written the same way, to a
  dedicated `node_samples` table (ADR 0027).
- Nothing deleted events. They stayed until an operator removed them by hand.

So a deployer reading ADR 0003 would believe raw events are not kept. They are, and they are
readable by anyone with access to the database.

Making the old sentence true is not a small change. Aggregates cannot be separated from raw rows
today:

- Aggregations read `payload` throughout: device, graphics, severity, UV, scale, custom-event
  properties and the query DSL all reach into it.
- The daily rollups (`perf_daily`, `events_daily`) are **views computed at query time** on every
  engine, not stored tables.

Dropping `payload` at ingest would therefore break analytics, and aggregates-only storage needs
real rollup tables. What can be done now is to bound how long raw events live.

## Decision

1. **`ENABLE_RAW_SESSION_RETENTION` keeps its name and its behaviour**, and is documented as what it
   is: an access gate, not a storage switch. Renaming it would break every deployment for a cosmetic
   gain. Ingest does not change.
2. **Add `EVENT_RETENTION_DAYS`.** When positive, the collector deletes events older than that many
   days, at startup and then every six hours. `0` disables the sweep and is the **default**.
3. **The sweep has the shape of the audit sweep** (`AUDIT_RETENTION_DAYS`, ADR 0051 §7): `<= 0`
   disables it, the timer is `unref`'d, the delete is idempotent so restarts and several instances
   cost nothing, and a failure is logged, never fatal, and retried by the next sweep.
4. **A new `pruneEvents(cutoffMs)` store method** on the `CollectorStore` contract, implemented by
   every store, so the storage detail stays behind the seam (ADR 0020).
5. **Scope: every raw event, and only raw events.** Both `events` and `node_samples` are pruned,
   because `node_transform` events are raw per-session data and leaving them behind would keep
   session positions past the window. Nothing else is touched: `projects`, `api_keys`,
   `scene_representations`, `scene_regions`, `annotations`, `glossary`, `saved_analyses`,
   `panel_specs` and `subscriptions` are the operator's own configuration and notes, not captured
   data. `subscription_events` is a firing log of metric values, already capped per subscription.
   `agent_audit` has its own window.
6. **Age is measured on `ts`**, the column every aggregate filters on, so the purge boundary lines
   up with what the aggregates see. A row exactly on the cutoff survives.
7. **The sweep logs its cutoff and no event content.** A failure logs only the first line of the
   error, because a DuckDB error can quote the rows it failed on. The sweep is not written to the
   agent audit trail: that trail records authenticated requests, a sweep has no key, and the audit
   sweep itself is not audited either.
8. **On DuckDB, `pruneEvents` drops the indexes on `events` and `node_samples` around the delete and
   rebuilds them from the shipped migrations.** This departs from `pruneAudit` because a plain
   `DELETE` can kill the database. On DuckDB 1.5.6, after an unclean exit, a process that replays the
   WAL and closes without an explicit `CHECKPOINT` leaves those rows out of the ART index. The
   collector's boot always checkpoints, so it is safe, but a DuckDB CLI session opened on the file
   after a crash is not. A `DELETE` that later reaches such a row raises a FATAL error that invalidates
   the whole instance, and since the sweep runs at boot, the collector would die on every start. The
   drop must be a separate statement: a `DROP INDEX` and `DELETE` in one transaction still fail. If the
   process dies in between, the index migrations restore the indexes on the next boot.

## Consequences

### Positive

- Deployers get a real bound on how long raw events, including `runtime_error` text, are kept.
- The docs and ADRs now state what the code does.
- Upgrading never deletes anything: a default must not destroy an existing deployment's history.

### Negative / trade-offs

- **Purging also removes those days from aggregates.** There is no rollup to fall back on, so a
  deleted day disappears from every dashboard, heatmap, funnel and metric, permanently. This is why
  the default is off, and why a window shorter than a metric's comparison period (an insight
  baseline, a subscription's window) degrades that metric.
- **A delete is not an erasure on disk.** On DuckDB the file does not shrink. Measured on a
  300,000-row file with 80% of rows deleted, after a `CHECKPOINT` and a restart: the file stayed at
  about 50 MB, and later inserts reused the freed space. Deleted payload bytes were still in the file
  in some runs and not in others, with no pattern to rely on, so they must be assumed to remain.
  `COPY FROM DATABASE` into a new file gave about 15 MB at 100,000 live rows, with no trace of the
  deleted rows in any run. Operators who need bytes gone must compact. The other engines reclaim on
  their own schedule (`VACUUM`, ghost cleanup, ClickHouse part merges).
- **`ts` is client-supplied.** The schema requires a non-negative integer and sets no upper bound,
  so an event stamped in the future by a wrong clock outlives the window until that date passes.
- **A session straddling the cutoff is partial** until the rest of it ages out. Once `session_start`
  is gone its descriptor goes too, so `GET /api/v1/sessions/:id/meta` answers `404` while newer
  events of that session remain.
- **The window is per collector**, not per project.
- **A sweep deletes across the whole table.** DuckDB's single connection means reads and ingest
  queue behind it, including the index rebuild, which took about 0.7 s for about one million surviving rows. The
  rebuilt indexes did not appear in the plans of the session and aggregate reads checked, which all
  used sequential scans, but removing them would mean editing shipped migrations, so they stay.
  ClickHouse runs a lightweight delete per table every six hours. No engine has an index that leads
  on `ts`, so the sweep is a table scan everywhere.
- **`pruneAudit` keeps the plain `DELETE`,** so `agent_audit` on DuckDB is still exposed to the FATAL
  described above. That predates this ADR and is left for its own change.
- **ADR 0003's privacy story is weaker than it read**, because it was never true. Raw events are
  stored by default, and this ADR says so rather than repairing it.

## Alternatives considered

- **Stop writing `payload` when the flag is off** — what ADR 0003 implied. It breaks aggregates that
  read `payload`, so most analytics would silently go empty for the default configuration.
- **Rollup tables, then aggregates-only storage** — the real fix: aggregate at write time, keep raw
  rows only on opt-in, and let purging leave the aggregates whole. Not chosen now because it is a
  redesign, not a change: every aggregation that reads `payload` needs a stored equivalent on four
  engines plus parity coverage, and the query DSL needs a story for arbitrary filters. The contract
  added here does not stand in its way.
- **A non-zero default, such as 90 days** — better privacy out of the box, but it would delete an
  upgrader's history and aggregates with no action on their part.
- **Purge whole sessions only**, once a session's last event passes the cutoff — no partial
  sessions, but a long or never-ending session would hold raw events past the window, which is the
  thing being bounded, and it needs a per-session scan on every sweep.
- **Age by `inserted_at`** — server-set, so it would not trust a client clock, but a purge boundary
  that differs from the `ts` the aggregates filter on would cut days unevenly, and the memory store
  has no such field.
- **Engine-native expiry (ClickHouse `TTL`, partition drops)** — one engine only, and a window fixed
  in the schema rather than configured. The same reason `agent_audit` uses a delete.
- **Renaming the flag** to something like `ENABLE_RAW_SESSION_ACCESS` — more honest, but a breaking
  change for every deployment; the docs carry the correction instead.
