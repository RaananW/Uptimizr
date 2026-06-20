# ADR 0032: Live sessions and real-time presence (active-now + live follow)

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Project owner, engineering
- **Relates to:** [ADR 0003](./0003-privacy-model.md) (privacy gate), [ADR 0006](./0006-session-replay.md)
  (replay), [ADR 0015](./0015-replay-ndjson-streaming.md) (streaming / cursor),
  [ADR 0020](./0020-open-core-storage-boundary.md) (OSS single store), [ADR 0004](./0004-monorepo-separation.md)
  (self-contained OSS monorepo), [ADR 0012](./0012-sampling-and-fidelity.md) /
  [ADR 0031](./0031-optional-worker-offload.md) (SDK cost defaults)

## Context

[Issue #102](https://github.com/RaananW/Uptimizr/issues/102) asks for three things the dashboard
cannot do today:

1. **Presence** — show how many people are running a live session *right now*, and a roster of the
   currently active sessions (an "active now" metric, aggregate).
2. **Live dashboard updates** — watch the dashboard's own panels (event feed, counters, and the
   analytics tiles) **update in place as events arrive**, instead of only on a manual/polled
   refetch. This is the primary ask: the dashboard reflects what is happening as it happens.
3. **Live follow (replay)** — open one of those active sessions and re-drive it in a scene viewer
   **in real time** (live, per-session replay). A high-value extra on top of (2).

Today's pipeline is deliberately **batch + pull**:

- The SDK **batches** events and ships them with `sendBeacon` to keep cost off the render thread
  (ADR 0012 sampling, ADR 0031 worker offload).
- `collector-server` does `validate → enrich → insert`
  ([`collect.ts`](../../oss/apps/collector-server/src/routes/collect.ts)) into the single store
  (DuckDB, ADR 0020) or ClickHouse (ADR 0002).
- The dashboard **polls** the read API (debounced refetch on filter change,
  [`page.tsx`](../../oss/apps/dashboard/src/app/page.tsx)). There is **no streaming path** — no SSE,
  no WebSocket, no in-process fan-out — and the only "live" element is a polled event feed.

Three forces constrain the design:

- **Latency is bounded by the SDK flush cadence.** "Real-time" is honestly *near*-real-time. We
  must not lower the default flush to chase latency — that would break the conservative,
  cost-first defaults of ADR 0012 / ADR 0031.
- **Privacy.** Following an individual session live is the same act as replaying it: it requires
  the raw, ordered per-session stream, which is **opt-in** (`ENABLE_RAW_SESSION_RETENTION`,
  ADR 0003 / ADR 0006). A *count* of active sessions is aggregate and privacy-safe.
- **Topology.** The OSS collector is a **single process** (DuckDB is single-writer, ADR 0020), so
  every event already passes through one place at ingest. A multi-instance, multi-writer deployment
  at scale is where a single process does **not** see every event.

## Decision

Add a **live layer** to the OSS collector and dashboard: a privacy-safe **presence** tier, a
**live dashboard-update** tier, and a retention-gated **live-follow (replay)** tier — all delivered
over **Server-Sent Events (SSE)** and fanned out from a single **in-process event bus**. The light
path (presence, feed, live counters, throttled panel refresh, per-session live follow) is
**Phase 1**; the heavy path (continuous *incremental* aggregation of spatial heatmaps and
percentile rollups) is **Phase 2** (see §9).

### 1. Liveness is a sliding window, not a new event

A session is **live** if it has produced any event within `LIVE_WINDOW_MS` (default **30 s**, which
must stay **≥ the SDK default flush cadence** so a healthy session never flickers out between
flushes). **Active visitors now** = distinct `visitorId` among live sessions. No new schema/event
type is introduced (`@uptimizr/schema` unchanged); liveness is derived from the existing
`session_start` / `session_end` / interaction stream and the server-set `ts`.

### 2. In-process event bus at the ingest seam

The collector gains a small **in-process publish/subscribe bus** (Node `EventEmitter` / async
iterator, zero new dependencies). The ingest route publishes each **enriched, validated** event to
the bus immediately after `enrichEvents`, concurrently with the async store insert. The bus is the
single fan-out source for all live consumers and the source of truth for the presence roster (an
in-memory map of `sessionId → { sceneId, startedAt, lastSeen, coarseGeo? }`, pruned by
`LIVE_WINDOW_MS`). Because OSS is single-process, in-process fan-out is **complete and correct**.

### 3. Three SSE surfaces

All endpoints sit behind the same project/API-key authorization as the query API and emit
`text/event-stream`:

- **`GET /api/v1/live/presence`** — pushes rolling **active-session and active-visitor counts** plus
  a **privacy-minimal roster** (see §3a). **Aggregate and privacy-safe → available regardless of
  raw-retention.** Powers the "N live now" badge and the live-session list.
- **`GET /api/v1/live/stream`** — a **project-scoped firehose** of arriving events (optionally
  filtered by scene/event-type), used by the dashboard to **update its panels in place**: the live
  event feed and light counters update directly from the stream; heavier analytics tiles trigger a
  **throttled re-query** of the existing read endpoints when the stream signals new activity
  (Phase 1). Continuous *incremental* aggregation of those tiles is Phase 2 (§9). Event payloads in
  this stream carry **no more than the aggregate read API already exposes** (no raw per-session
  detail unless raw-retention is on).
- **`GET /api/v1/live/sessions/:id`** — the **live-follow** tail: the ordered event stream of one
  session as it arrives, for per-session **live replay**. **Gated behind
  `ENABLE_RAW_SESSION_RETENTION`, identical to historical replay** (ADR 0003/0006). On connect it MAY
  backfill the recent in-memory buffer (so the viewer isn't blank), then streams new events live.

SSE is chosen over WebSocket: the data flow is one-way (server → browser), `EventSource` is native,
it runs over plain HTTP through Fastify with no new protocol, and reconnection + `Last-Event-ID`
are built in. This keeps the backend thin (ADR 0005) and mirrors the existing read-API shape.

### 3a. Privacy-minimal presence roster

The presence roster is available even when raw-retention is **off**, so it must not become a
per-individual surface. It carries only **non-identifying** fields: an opaque `sessionId`, the
`sceneId`, `startedAt`, `lastSeen`, and a coarse activity hint (e.g. live event rate bucket). It
does **not** include per-session geo, IP-derived location, user agent, or any `visitorId`-linked
attribute; geo remains a coarse **aggregate** (country-level counts) only. Per-session detail
appears only through the retention-gated live-follow tier (§3, ADR 0003/0006). This keeps presence
on the right side of the privacy goal (ADR 0003) by construction.

### 4. Live follow reuses the replay stack

Live follow is **replay, tailing**. The dashboard feeds the SSE stream into the existing
`@uptimizr/replay` player exactly as it consumes the NDJSON stream (ADR 0015); a live session is a
replay whose stream has not ended. This realizes the **`afterTs` cursor** use-case ADR 0015
deferred — the live tail is "give me everything after the last `ts`, and keep the connection open".
No parallel replay implementation is created.

### 5. Latency: defaults unchanged, opt-in live flush

"Real-time" is **near-real-time, bounded by the SDK flush cadence**; the ADR 0012 / ADR 0031
defaults stand and are **not** lowered. Integrators who want tighter latency MAY opt into a
lower-latency **live flush cadence** in SDK config — off by default, never required for correctness,
and orthogonal to the worker-offload valve (ADR 0031).

### 6. Bounded resources and backpressure

Live connections must never grow server memory unboundedly (the same concern ADR 0015 addressed for
historical streams):

- Each subscriber has a **bounded queue with drop-oldest**; a slow dashboard loses old frames, it
  does not back-pressure ingest or balloon memory.
- **Heartbeat / idle timeout** closes dead connections; the recent-event backfill buffer is a
  **bounded ring** per session.
- A **max concurrent live-connection** cap per project sheds load predictably.

### 7. EventSource auth without leaking the API key

`EventSource` cannot send an `Authorization` header. The dashboard's **own server** mints a
**short-lived, project-scoped signed token** that the browser passes to the live endpoints (query
param or cookie); the raw API key is **never** placed in a URL. The underlying authorization model
(project resolution from the key) is unchanged.

### 8. Single-process fan-out and the scale tier

The in-process bus serves the **single-instance** collector fully. A multi-instance,
multi-writer deployment at scale would need a **shared fan-out bus** (e.g. Redis/NATS pub-sub or a
ClickHouse live tail) because no single process sees every event — that is out of scope here
(ADR 0004 / ADR 0020). The contract — endpoint shapes, SSE event
format, presence semantics, replay reuse — is identical regardless of fan-out transport; only the
transport behind the bus seam differs. The bus is therefore introduced as a small interface so an
alternative implementation can be supplied without touching the rest of `oss/**`.

### 9. Phase split — light path now, heavy aggregation later

The feature is Phase 1 **except** the part that is genuinely processing-heavy, which is deferred so
it cannot drag the rest:

- **Phase 1 (light, ship now):** the in-process bus (§2); the presence tier (§1, §3, §3a); the
  live firehose (§3) driving the **live event feed**, **live counters/tiles**, and **throttled
  re-query** of existing aggregate endpoints on activity; and **per-session live follow/replay**
  (§4) — cheap, because the replay player already exists and the stream is just events. None of
  this maintains server-side running aggregates.
- **Phase 2 (heavy, deferred):** **continuous incremental aggregation** — maintaining running
  server-side rollups so the spatial 3D heatmaps, percentile/perf panels, and click↔gaze surfaces
  update *continuously* (not by throttled re-query). This is the part with real CPU/memory cost
  (streaming voxel binning, per-session percentile state) and is where a shared bus and possibly the
  worker-offload seam (ADR 0031) matter. Deferring it keeps Phase 1 small while still delivering the
  felt "everything updates live" experience via the throttled-refresh path.

## Consequences

### Positive

- Delivers all of #102: a privacy-safe **active-now** count/roster, **dashboard panels that update
  as events arrive**, and retention-gated **per-session live replay** — with no new event types and
  no schema change.
- The **light/heavy phase split** lets the felt "live dashboard" experience ship in Phase 1 (feed,
  counters, throttled tile refresh) while the expensive continuous-aggregation work is isolated to
  Phase 2 and cannot block it.
- **Additive and seam-based:** a publish call at the ingest point plus two read endpoints; no change
  to enrichment, storage, the `CollectorStore` contract, or `@uptimizr/schema`.
- **Reuses replay** end-to-end — one replay engine for historical and live — and finally exercises
  the `afterTs` tail ADR 0015 anticipated.
- Privacy posture is preserved by construction: presence is aggregate; live follow inherits the
  exact replay gate (ADR 0003/0006).
- Bounded backpressure keeps a slow or numerous dashboard audience from threatening ingest or
  server memory.

### Negative / trade-offs

- A **new stateful surface** in the collector (the bus + presence map + open SSE connections) that
  must be capped, idle-timed, and tested — more moving parts than the stateless query API.
- **Latency is inherently bounded by SDK flush cadence**; without an opt-in live flush, "real time"
  can lag by a flush interval. Setting expectations in the UI matters.
- **Two fan-out implementations** possible long-term: in-process for single-instance, shared-bus for
  multi-instance at scale — the bus
  interface must stay clean or the seam rots (same discipline ADR 0031 demands of the processor
  seam).
- **EventSource auth** needs the dashboard server to mint short-lived tokens — a small new auth path
  to build and protect.

## Alternatives considered

- **Poll the read API faster (no streaming).** Simplest — reuse the existing pull model on a short
  interval. Rejected as the primary mechanism: wasteful at the fan-out (every viewer re-queries the
  store), laggy, and it gives no clean per-session live tail. (Polling remains an acceptable
  *fallback* for the presence count where SSE is unavailable.)
- **WebSocket instead of SSE.** Bidirectional, but the live layer is one-way server→browser;
  WebSocket adds a second protocol, manual reconnection, and proxy/keep-alive complexity for no
  benefit here. SSE fits the thin-HTTP backend (ADR 0005).
- **Query the store for "active now" on each request.** Works at small scale (recent-window
  `COUNT DISTINCT`), but couples presence latency to DB load and doesn't provide the per-session
  live push. The in-process bus is cheaper and also feeds live follow; the store query remains a
  fine cold-start/backfill source.
- **Add a dedicated `presence`/`heartbeat` event to the schema.** Rejected: liveness is derivable
  from the existing stream + server `ts`; a new event type would add wire weight and a privacy
  surface for no gain ("events live once", AGENTS.md).
- **Lower the default SDK flush to make it feel real-time.** Rejected: violates the cost-first
  defaults of ADR 0012 / ADR 0031. Lower latency is an explicit opt-in, never the default.
- **Incrementally aggregate every panel live in Phase 1** (maintain running 3D-heatmap/percentile
  state server-side). Rejected *for now*: it is the genuinely heavy part (streaming voxel binning,
  per-session percentile state) and would bloat Phase 1. The throttled re-query of existing
  endpoints delivers a live-feeling dashboard cheaply; true incremental aggregation is Phase 2 (\u00a79).
- **Per-session detail in the presence roster** (geo/UA per active session). Rejected against the
  privacy goal (ADR 0003): the roster is available without raw-retention, so it stays
  non-identifying; per-session detail is reachable only through the gated live-follow tier.
- **Build the shared-bus fan-out for scale now.** Out of scope (ADR 0004):
  the collector ships the in-process bus; a multi-instance deployment can supply its own behind the
  same interface later.
