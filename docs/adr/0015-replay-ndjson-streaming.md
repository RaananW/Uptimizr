# ADR 0015: NDJSON streaming for the session-replay event stream

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

Session replay ([ADR 0006](./0006-session-replay.md)) delivers a session's ordered event timeline
over `GET /api/v1/sessions/:id/events` (gated by raw-session retention,
[ADR 0003](./0003-privacy-model.md)). The original implementation buffers the whole session as
**one JSON array** on both ends:

- the server reads every row, parses + validates each, and serializes a single JSON body;
- the client downloads the whole body, validates the **entire array**, then plays it back.

For typical sessions (hundreds–low thousands of events) this is fine. For long/dense sessions it
costs high server memory, a multi-MB single response, slow client parse/validate, and no
progressive playback. The [design sketch](../phases/replay-streaming-design.md) lays out the full
scalability path (NDJSON wire format **plus** a time-windowed cursor and a sliding-window player).

The cursor half needs a stable secondary ordering key because `ts` (epoch ms) is **not unique**
within a session — resuming "strictly after the last `ts`" can drop or duplicate events on a
millisecond boundary. A correct cursor therefore requires a monotonic per-session sequence
exposed at ingest, which is a schema/ingest change that is hard to reverse. The NDJSON wire format,
by contrast, is additive and independently valuable. We split the work and lock only the wire
contract here.

## Decision

- Add an **NDJSON** (`application/x-ndjson`) representation of the replay event stream, negotiated
  by `Accept: application/x-ndjson` or a `?format=ndjson` query hint. One event per line.
- The **JSON array remains the default** representation (no `Accept`/`format` ⇒ unchanged
  behavior), so existing clients and the dashboard's per-session reads are unaffected.
- The server streams ClickHouse rows (`JSONEachRow` → per-row serialize) instead of materializing
  the whole result set, keeping server memory bounded.
- Clients validate **per line**: a malformed/invalid line is **skipped and counted**, not fatal to
  the whole fetch. `@uptimizr/replay` exposes `fetchSessionEventsStream` (async iterator) beside
  the unchanged array `fetchSessionEvents`, and negotiates transparently — if a collector ignores
  the request and returns a JSON array, the stream helper parses and yields from that array so it
  works against old and new servers alike. `replayInScene` consumes the streaming helper.
- Events are emitted in `ts ASC` order; `ReplayPlayer` also sorts defensively, so ordering is
  guaranteed regardless of transport.
- **Deferred (not part of this ADR):** the time-windowed cursor (`afterTs`/`limit` + next-cursor),
  the sliding-window `ReplayPlayer`, and the monotonic per-session sequence the cursor tiebreaker
  needs. Until those land, the streaming path still loads the full session into the player; the win
  is bounded server memory, per-line validation, progressive download, and graceful negotiation.

## Consequences

### Positive

- Bounded server memory and progressive download for large sessions, with no change for small ones.
- Per-line validation isolates a single bad row instead of failing the entire replay.
- Additive and backward-compatible: array stays default, streaming auto-negotiates and falls back.

### Negative / trade-offs

- Two representations of the same endpoint to keep in sync and test.
- The headline scalability wins (constant-time playback start, bounded **client** memory) wait on
  the deferred cursor + windowed player; this ADR is the first, reversible half.

## Alternatives considered

- **Ship NDJSON + cursor together** — fuller solution, but forces the hard-to-reverse per-session
  sequence/ingest change now; deferring it keeps this step additive and low-risk.
- **Chunked JSON array (no NDJSON)** — avoids a new media type but is awkward to parse incrementally
  and offers no clean per-line validation boundary.
- **Keep array-only** — simplest, but leaves long/dense sessions on the non-scaling path the design
  sketch set out to fix.
