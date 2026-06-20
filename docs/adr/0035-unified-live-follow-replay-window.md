# ADR 0035: Unified live-follow replay window (single birdview, internal playhead)

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Project owner, engineering
- **Relates to:** [ADR 0006](./0006-session-replay.md) (replay), [ADR 0015](./0015-replay-ndjson-streaming.md)
  (streaming / `afterTs` cursor), [ADR 0032](./0032-live-sessions-and-realtime-presence.md)
  (live sessions / presence / live follow), [ADR 0003](./0003-privacy-model.md) (raw-retention gate)

## Context

[ADR 0032](./0032-live-sessions-and-realtime-presence.md) shipped the live layer: presence, a
project firehose, and a retention-gated **per-session live-follow** tail
(`GET /api/v1/live/sessions/:id`). §4 of that ADR said live follow "reuses the replay stack" by
feeding the SSE stream into the existing `@uptimizr/replay` `ReplayPlayer`.

In the dashboard the first implementation did **not** reuse the historical replay UI. It added a
**separate** `LiveSessionReplay` panel rendered _below_ the historical `SessionReplay` birdview when
a session was live. That produced two stacked 3D viewers for the same session:

- the historical birdview with a scrubber and a colour-coded event timeline, and
- a second, timeline-less birdview that only ever followed the live edge.

This is confusing (two cameras, two scenes, no shared timeline) and contradicts the spirit of
ADR 0032 §4 ("one replay engine for historical and live; no parallel replay implementation"). It
also wastes a second Babylon engine/canvas for the same data.

The obstacle to literally reusing `ReplayPlayer` for live is structural: **`ReplayPlayer.durationMs`
is computed once at construction** (last event `ts` − base `ts`) and is `readonly`. A live session's
timeline **grows** as events arrive, so a fixed-duration player cannot represent the live edge moving
forward, and its `onComplete`/auto-pause semantics fire at a "duration" that is really just "the last
event we happened to have when we connected."

## Decision

**Unify live follow into the one `SessionReplay` birdview window** and drive the live playhead from an
**internal wall clock** instead of the fixed-duration `ReplayPlayer`. Retire the separate
`LiveSessionReplay` panel.

1. **One window, `isLive` branch.** `SessionReplay` takes an `isLive` prop (set from the presence
   roster). The historical path is **unchanged**: it still constructs a `ReplayPlayer` over the
   fetched events and uses it purely as the clock (the visualization itself is driven deterministically
   by playhead time in `redrawAt`, the player's driver is a no-op). When `isLive` is true the component
   **skips the player** and runs an internal clock in the Babylon render loop.

2. **Internal playhead for live.** While **following**, the render loop advances the playhead by the
   per-frame wall-clock delta so interaction trails fade in real time, and **grows** `durationMs` (the
   scrubber max) with it. New events from the live tail are appended to the same precomputed arrays the
   historical path uses (`cameraSamples`, `rays`, `actorSamples`), bounds are grown, and the timeline
   strip is rebuilt (throttled). A `frontierTs` cursor dedupes the connect-time backfill overlap — the
   realization of the `afterTs` tail ADR 0015 anticipated, here as "everything after the last `ts` I
   have, and keep growing."

3. **Follow vs. review.** A **● LIVE** control pins the playhead to the growing edge (following).
   Scrubbing or pressing Play drops out of follow into **review** mode — the same scrubber and
   colour-coded timeline as historical replay — over the events captured so far. ● LIVE snaps back to
   the edge and resumes following. Live never "completes" (no auto-pause at a synthetic duration).

4. **Same privacy gate, surfaced in place.** Live follow tails the retention-gated
   `GET /api/v1/live/sessions/:id` (ADR 0032 §3, ADR 0003/0006). A `403` (`gated`) is surfaced as an
   inline note in the same window rather than a separate disabled panel. When raw retention is off the
   historical fetch is also empty, so the window shows the existing empty state consistently.

5. **Retire `LiveSessionReplay`.** The separate component is deleted; the dashboard renders a single
   `SessionReplay` for both historical and live sessions, naturally primary because it is the only and
   topmost session viewer.

## Consequences

### Positive

- One coherent viewer per session: a single camera, scene, scrubber, and timeline for both live and
  historical — you can scrub back through what already happened on a live session and jump back to the
  edge, which the separate live panel could not do.
- Honours ADR 0032 §4 in the UI ("one replay engine, no parallel implementation"); removes a second
  Babylon engine/canvas for the same data.
- The historical code path is untouched (`ReplayPlayer` still drives non-live), so the change is
  isolated to an `isLive` branch — lower regression risk.

### Negative / trade-offs

- The live playhead is **not** the `ReplayPlayer`; it is an internal wall clock in the render loop.
  This is a deliberate divergence from ADR 0032 §4's "feed the stream into the player" wording, forced
  by `ReplayPlayer.durationMs` being fixed/`readonly`. The player remains the single engine for
  **historical** replay; only the live **clock** differs. If `ReplayPlayer` later grows a
  growing-duration/tail mode, the live branch can fold back onto it.
- Following re-renders the scrubber each frame (as historical play already does); acceptable, and
  `setDuration` is throttled.
- A brand-new tracked actor first seen live needs its marker created on demand (mirrors the build-time
  actor loop).

## Alternatives considered

- **Keep the two separate panels.** Rejected: two 3D viewers for one session, no shared timeline, no
  scrub-back on live, and it visibly contradicts ADR 0032 §4.
- **Extend `ReplayPlayer` with a growing/tail duration and use it for live.** Deferred: it would change
  a shared, well-tested replay primitive used by external SDK consumers (`@uptimizr/replay`) for a
  dashboard-only need. The internal-clock branch keeps the SDK contract stable; this remains the clean
  long-term home if/when a tail mode is added.
- **Make the live view primary by reordering panels only.** Insufficient: it leaves the duplicate
  viewer and the missing shared timeline.
