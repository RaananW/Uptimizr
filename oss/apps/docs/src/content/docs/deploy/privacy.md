---
title: Privacy & configuration
description: Uptimizr's privacy model and the configuration that controls raw session access, event retention, CORS, and opt-in capture.
lastUpdated: 2026-11-06
---

Uptimizr is privacy-first by architecture: the responsible default is the easy default.

## The privacy model

- **Cookieless, no client IDs.** No cookies, no `localStorage` identifiers, no fingerprinting.
  Nothing persistent is written to the visitor's device. The `sessionId` is in-memory only.
- **Server-side rotating visitor hash.** Visitors are counted with a hash computed **on the
  server** that rotates **every day**, so individuals can't be tracked across days.
- **Derived, coarse browser/OS — never the raw User-Agent.** The request User-Agent is used only to
  compute the visitor hash and to derive a coarse `{ browser, os }` family pair (e.g. `Safari` /
  `iOS`) for the performance device segment. The raw User-Agent and version are never stored — only
  the two low-cardinality families. Derived, non-PII (ADR 0003 / ADR 0042).
- **No PII by default.** Events carry spatial and performance signals, not personal data. Never put
  PII in `meta`, `track` props, or `user`.
- **Opt-in user descriptor.** `user.id` must be pseudonymous or hashed — never an email, username,
  or raw account id. Omit it to stay fully anonymous (see
  [sdk-core](/docs/connectors/sdk-core/#anonymized-users-opt-in)).

## Raw session access is opt-in

Reading raw per-session streams — the ordered events that power **replay** — through the API is
**opt-in** on the collector:

```bash
ENABLE_RAW_SESSION_RETENTION=true
```

Despite its name, this flag gates **access, not storage**. The collector always writes every event
to the store, including each event's full payload, because aggregates are computed from those rows
at query time.

With the flag off, `/api/v1/sessions/:id/events`, `/api/v1/sessions/:id/narrative` and the live
per-session follow `/api/v1/live/sessions/:id` return `403`. The raw events remain in the store and
are readable by anyone with access to the database file or server. The aggregate endpoints never
expose raw events.

Stored events stay until something removes them, and by default nothing does. See
[Event retention](#event-retention) to bound them.

The flag is only **half** the gate. Reading a raw per-session stream — the replay timeline
`/api/v1/sessions/:id/events`, the compacted `/api/v1/sessions/:id/narrative` and the live
per-session follow `/api/v1/live/sessions/:id` — also requires an API key holding the `query:raw`
[capability](/docs/deploy/collector/#api-keys-and-capabilities). A plain `query` key reads
aggregates only, whatever the flag is set to, so "who may see raw sessions" is a deliberate,
per-key decision rather than a collector-wide switch.

:::caution[Breaking change]
This is a tightening: previously `ENABLE_RAW_SESSION_RETENTION` alone was enough and any `query`
key could read the raw stream. Existing keys keep working for every aggregate endpoint; a key that
drives replay or live-follow must be re-minted with
`uptimizr new-key <projectId> --capabilities query,query:raw`.
:::

### What a session narrative shows

`GET /api/v1/sessions/:id/narrative` sits behind the same two gates and returns a **projection**
of the raw stream, not the stream itself. It is an allow-list, not a redactor: it reads only the
fields below, so a future event type cannot widen it by accident.

It **shows** relative timestamps (milliseconds since the session's first event, never a wall-clock
time), scene ids, mesh/object names, interaction kinds and input sources, custom-event and
input-action **names**, frame-rate dips, runtime-error messages (truncated), graphics-diagnostic
category and severity, capability transitions, and the rendering engine / graphics API.

It **never** carries:

- the daily-rotating `visitorId`, or any identifier for a person;
- the page URL, referrer, title, language or any other `pageMeta` field;
- anything from the app-supplied `user` descriptor (`user.id`, traits);
- any position, hit point, ray, UV or screen coordinate;
- any `device` detail beyond the engine — no renderer or vendor string, OS, browser, memory or
  core count;
- custom-event property **values** — only their keys, which are developer-chosen field names;
- a runtime error's `source` (a URL) or `stack`, or a graphics diagnostic's message text.

If your app attaches personal data to a custom-event property or to an error message, that is the
one place it could reach a narrative — error messages are truncated but not filtered, which is the
same trade-off as the raw stream and the dashboard's error panels.

## Event retention

Events are kept indefinitely by default. To bound how long they live, set a window in days:

```bash
EVENT_RETENTION_DAYS=90
```

The collector then deletes events older than that at startup and every six hours. `0`, the default,
disables the sweep, so upgrading a collector never deletes anything.

:::caution[Purging also deletes those days' aggregates]
Aggregates are computed from the stored events at query time; there is no separate rollup to fall
back on. A deleted day disappears from every dashboard, heatmap, funnel and metric, and it cannot be
recovered. Keep the window longer than the longest comparison you rely on, such as an insight
baseline or a subscription's window.
:::

- **What goes:** every raw event, in every project, including `node_transform` samples. It applies
  whatever `ENABLE_RAW_SESSION_RETENTION` is set to. The window is per collector, not per project.
- **What stays:** projects, API keys, scene representations and regions, annotations, the glossary,
  saved analyses, panels and subscriptions. The agent audit log has its own window, below.
- **Age is the event's `ts`,** which the client sets. An event stamped in the future by a wrong clock
  stays until that date has passed. The cutoff is a moment, not a calendar day, so the oldest day left
  in your aggregates is usually partial.
- **Sessions can straddle the cutoff.** The older part goes first. Once a session's `session_start` is
  gone, `GET /api/v1/sessions/:id/meta` answers `404` while its newer events remain, until they age out
  too.
- **A failed sweep is not fatal.** It is logged and the next sweep retries. A sweep logs its cutoff,
  never event content.
- **A sweep scans the event tables.** On DuckDB, reads and ingest wait while it runs, because it also
  rebuilds the indexes on those tables: about 0.7 s for about a million surviving rows in testing.

### Deleted is not the same as gone from disk

A deleted event can no longer be read through the collector, but each engine reclaims the space in
its own way.

On **DuckDB** the file does **not shrink**. In a 300,000-row test with 80% of rows deleted, the file
stayed at about 50 MB after a checkpoint and a restart, and later inserts reused the freed space.
Deleted bytes can also remain in the file: they were still found in it in some test runs and not in
others, so assume they are there. To shrink the file and drop those bytes, stop the collector and
copy the database with a DuckDB CLI of the same version line as the collector:

```sql
ATTACH 'uptimizr.duckdb' AS src (READ_ONLY);
ATTACH 'compacted.duckdb' AS dst;
COPY FROM DATABASE src TO dst;
```

Then replace `uptimizr.duckdb` with `compacted.duckdb` and delete the old file. In the same test the
copy came to about 15 MB at 100,000 live rows, with no trace of the deleted rows.

**Postgres** frees space for reuse through autovacuum, and `VACUUM FULL` returns it to the operating
system. **SQL Server** clears deleted rows with its background ghost cleanup; shrinking a file is a
separate step. **ClickHouse** hides deleted rows at once and removes them from disk when their parts
next merge.

## Agent activity is audited

Every authenticated request made with a key that is not the dashboard's own session is written to
an audit trail the project owner can read at `GET /api/v1/audit`: which key (by **id** — never the
key), which endpoint, bounded and redacted parameters, rows returned, duration and status.
Credential-shaped parameters are dropped before the row is written, and rows expire after
`AUDIT_RETENTION_DAYS` (default 30). See
[the collector guide](/docs/deploy/collector/#agent-audit-log).

## Project metadata is yours to write — and yours to keep clean

Annotations, the glossary and saved analyses ([metadata endpoints](/docs/api/metadata/)) are the one
place in the collector holding free text you wrote rather than data it captured. They are
**project-scoped** — readable only with that project's key, never shared across projects — bounded in
both length and count, and every write is recorded in the agent audit trail above, with the key that
made it. Writing any of them requires the `annotate` capability; a read-only key cannot.

Because it is free text, it is also the one surface the collector cannot keep non-PII for you. Do not
paste personal data into a note, a definition or a conclusion. Nothing on this path touches captured
events: they remain read-only and aggregate-only.

## Opt-in capture channels

Several capture channels are off by default for privacy and cost, and must be enabled per scene in
the connector (`capture.*` / options):

| Channel          | Event                    | Discloses                                           |
| ---------------- | ------------------------ | --------------------------------------------------- |
| `meshVisibility` | `mesh_visibility`        | Per-object dwell; with `boundingBox`, scene layout. |
| `hoverDwell`     | `hover_dwell`            | Hover hesitation per object.                        |
| `resourceSample` | `resource_sample`        | GPU/memory footprint.                               |
| `gaze`           | `camera_sample.hitPoint` | Where users looked on the geometry.                 |
| `captureErrors`  | `runtime_error`          | Error messages (not auto-redacted).                 |

Enable only what you need.

## CORS & origins

Restrict which browser origins may post and query:

```bash
COLLECTOR_CORS_ORIGINS=https://app.example.com,https://www.example.com
```

An empty dashboard or rejected ingestion is most often a CORS mismatch or a collector URL pointing
at the wrong host.

## Tenant isolation

Every read and write authenticates with a project API key; the project is resolved from the key
server-side. There is no cross-project query — a caller can only ever access its own data.
Do not add a `projectId` param to widen a query; it is ignored.
