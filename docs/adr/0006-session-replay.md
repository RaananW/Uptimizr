# ADR 0006: Session replay on the user's own infrastructure

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

Beyond aggregate analytics, framework users want to **replay** an individual end-user's session
inside their own 3D scene — watching the camera move, the pointer travel, and meshes get picked,
exactly as the end-user experienced it. The owner wants this replay to run on the framework
user's **own** infrastructure (using the collector).

## Decision

- The event schema is **replay-complete**: every interaction event is ordered, timestamped, and
  keyed by `sessionId` with enough fidelity (camera pose, pointer position, picked mesh) to
  reconstruct the session.
- `@uptimizr/db` and `collector-server` retain and expose the **raw, ordered per-session event
  stream** via `GET /api/v1/sessions/:id/events`. This retention is opt-in
  (see [ADR 0003](./0003-privacy-model.md)).
- A dedicated OSS package, **`@uptimizr/replay`**, provides a framework-agnostic replay core
  plus a Babylon driver that re-drives camera/pointer/picks over the framework user's own scene.
- The dashboard v1 ships **abstract aggregate** heatmaps; an in-dashboard per-session replay
  viewer is a stretch goal. Full scene-`.glb` overlay is deferred.

## Consequences

### Positive

- Framework users get high-value, scene-accurate replay without sending raw sessions to a
  third party.
- Clean reuse: the same schema powers capture, aggregation, and replay.

### Negative / trade-offs

- Storing raw ordered sessions costs more storage and carries privacy obligations; hence it is
  opt-in and documented.
- Replay fidelity depends on sampling rates chosen by the SDK (a perf/accuracy trade-off the
  adapter must expose as configuration).

## Alternatives considered

- **Aggregate-only (no replay)** — simplest and most private, but omits a headline feature the
  owner explicitly wants.
- **Server-side video recording of sessions** — heavy, privacy-invasive, and engine-specific;
  event-driven re-drive in the user's own scene is lighter and more faithful to 3D context.
