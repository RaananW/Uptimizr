# Design sketch — replay data streaming (vs. single-JSON delivery)

> **Status:** Partially shipped. The **NDJSON wire format** (§1) is implemented and locked by
> [ADR 0015](../adr/0015-replay-ndjson-streaming.md): the events endpoint negotiates
> `application/x-ndjson`, the server streams ClickHouse rows, and `@uptimizr/replay` exposes
> `fetchSessionEventsStream` (per-line validation + JSON-array fallback) which `replayInScene`
> consumes. The **time-windowed cursor** (§2) and **sliding-window player** (§3) are **still
> mutable design notes / deferred** — they need a monotonic per-session sequence (see the
> tiebreaker note), an ingest/schema change that should graduate via its own ADR before shipping.
> See [phase plans](./README.md).

## Current behavior (and why it doesn't scale)

The replay timeline is delivered as **one JSON array**, fully buffered on **both** ends:

- **Server** — [`getSessionEvents`](../../oss/packages/db/src/clickhouse/events.ts) runs
  `SELECT payload ... ORDER BY ts ASC`, reads **all** rows, `JSON.parse`s each `payload`,
  Zod-validates each, builds one array, and the Fastify route serializes it as a single JSON body.
- **Client** — [`fetchSessionEvents`](../../oss/packages/replay/src/fetchSession.ts) downloads the
  whole body, `JSON.parse`s it, validates the **entire array** with `z.array(anyEventSchema)`,
  sorts, and hands it to `ReplayPlayer`, which holds **all** events in memory before playback can
  start.

For a typical analytics session (hundreds–low thousands of events — e.g. the verified 337-event
session) this is fine. For a long/dense session (100k–1M+ events) it becomes:

- **High server memory** — the full result set + parsed objects materialized at once.
- **A multi-MB single response** — slow first byte, no progress, easy to hit body limits.
- **Slow client parse/validate** — one big `JSON.parse` + whole-array Zod validation blocks before
  anything plays.
- **No progressive playback** — the user waits for 100% download before frame one.

## Goals

1. Playback starts in ~constant time regardless of total session size.
2. Bounded server memory (stream rows, don't materialize).
3. Bounded client memory (sliding window, not the whole session).
4. Backward-compatible path for small sessions / older clients.
5. Preserve correctness: events still applied in `ts` order, replay stays deterministic/seekable.

## Approach

### 1. Wire format — NDJSON streaming (`application/x-ndjson`)

One event per line. ClickHouse already streams `JSONEachRow`, so the server can pipe rows straight
through with minimal buffering; the client consumes a `ReadableStream`, validates **per line**, and
can begin playback as soon as the first window has arrived.

- New behavior negotiated by `Accept: application/x-ndjson` (or a `?format=ndjson` param) so the
  existing JSON-array response stays the default for current clients.
- Per-line Zod validation replaces whole-array validation; a malformed line is skipped (and counted)
  rather than failing the entire fetch.

### 2. Pagination / cursor (time-windowed)

Add a cursor to the events endpoint so replay can fetch the first slice, start playing, and
prefetch the rest:

- `GET /api/v1/sessions/:id/events?afterTs=<ms>&limit=<n>` (and/or `since`/`until`).
- Response carries the next cursor (last `ts` + a tiebreaker for equal timestamps — `ts` is not
  unique, so pair it with a stable secondary key such as insertion order / a row sequence).
- The client requests the next window slightly ahead of the playhead.

### 3. Client — windowed `ReplayPlayer`

- `fetchSessionEvents` gains a streaming variant returning an async iterator / `ReadableStream`
  instead of a fully-resolved array.
- `ReplayPlayer` holds a **sliding window** (current playhead ± lookahead) and drops far-past
  events, requesting more as the playhead advances.
- Seeking backward past the buffer re-fetches from the appropriate cursor (still deterministic:
  the driver `reset()`s and re-applies from the window start).

### 4. Server guardrails

- Stream ClickHouse rows (don't `await result.json()` the whole set); back-pressure to the socket.
- Cap an individual response window (`limit`) and require the cursor for the remainder.
- Optional hard ceiling / segmentation for pathologically large sessions.

## Tiebreaker note (correctness)

`ts` (epoch ms) is **not unique** within a session — many events share a millisecond. Any cursor
must order by `(ts, <stable secondary>)` and resume strictly after the last `(ts, secondary)` pair,
or events on a millisecond boundary can be dropped or duplicated across windows. This likely means
exposing a monotonic per-session sequence (or using ClickHouse row ordering deterministically).

## Compatibility & rollout

- **Step 1 (additive):** add NDJSON + cursor support to the endpoint; keep the single-JSON array
  as the default. `@uptimizr/replay` gains an opt-in streaming fetch; `replayInScene` auto-uses it
  when available and falls back to the array otherwise. Small sessions are unaffected.
- **Step 2:** make streaming the default for `replayInScene`; keep the array response for explicit
  `Accept: application/json` and the dashboard's simpler reads.
- The streaming contract (NDJSON shape + cursor semantics + tiebreaker) is a public client
  dependency → **write an ADR** before locking it.

## Non-goals (for now)

- Server-side pre-aggregation/downsampling of replay (replay is intentionally raw, per ADR 0006).
- Real-time/live tail of an in-progress session (separate feature).
- Compression negotiation beyond standard HTTP `Content-Encoding` (gzip already helps; orthogonal).

## When to build this

Not urgent for current workloads (hundreds–thousands of events replay fine as a single JSON). This
is the scalability path for **long/dense sessions** and for the dashboard
[timeline scrubber](./dashboard-improvement-plan.md) once it loads large sessions interactively.
Prioritize after the dashboard timeline work makes large-session loading a real user path.

## Open questions

- Cursor secondary key: synthesize a per-session sequence at ingest, or rely on ClickHouse ordering
  guarantees? (Leaning explicit sequence for portability across stores.)
- Window size / lookahead defaults — fixed event count, fixed time span, or adaptive to event
  density? (Leaning time-span lookahead so dense sections don't starve.)
- Do we also stream the dashboard's per-session reads, or keep those array-based and only stream the
  in-scene replay path? (Leaning: stream only replay first.)
