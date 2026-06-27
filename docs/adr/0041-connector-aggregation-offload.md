# ADR 0041: Connector-side aggregation offload via one engine-agnostic Aggregator

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Uptimizr maintainers

## Context

[ADR 0031](./0031-optional-worker-offload.md) defined the worker-offload _boundary_ and the
`Processor` seam, then the client-level seam (#93–#99) shipped it: with `offload: "worker"`,
**serialization + network dispatch** move off the render thread. ADR 0031 was explicit that the same
boundary should eventually relocate the rest of the _processing_ phase too — the per-frame
number-crunching that still ran inside each connector:

- frame-time **percentiles** (p95/p99 sort + `longFrames` count),
- **matrix → position/quaternion/scale decomposition** for node/bone transforms (ADR 0027),
- **mesh-visibility aggregation** — centred/screen-fraction math, per-window bucketing, AABB
  dedupe/round (ADR 0012, #53),
- **idle-diffing** transforms and FPS against the last emitted value,
- **camera-gesture classification** (ADR 0025).

This math was **duplicated across four connectors** (`@uptimizr/babylon`, `@uptimizr/babylon-lite`,
`@uptimizr/three`, `@uptimizr/playcanvas`; `@uptimizr/r3f` and `@uptimizr/aframe` wrap those). It ran
interleaved with the main-thread engine reads, so it could not be offloaded while it lived there, and
every connector carried its own copy to keep in sync.

This ADR records the **realization** of ADR 0031's connector-side offload: where the snapshot ↔
processing boundary actually falls in the connectors, and the seam that lets the processing phase run
either main-thread or in the worker without forking logic. It does not change the wire contract or
the privacy model, and it does not supersede ADR 0031.

## Decision

Introduce **one engine-agnostic `Aggregator`** in `@uptimizr/sdk-core` that owns the entire
offload-eligible processing phase, and make every connector a **thin snapshot emitter**.

1. **Snapshot DTOs are the boundary.** Each frame a connector reads live engine state (the cheap
   snapshot phase that _must_ stay main-thread) into plain-number **snapshot DTOs** —
   `oss/packages/sdk-core/src/aggregation/snapshot.ts` — and hands them to
   `ctx.createAggregation(config)`. The DTOs carry only numbers, ids and timestamps; no engine or DOM
   handle crosses the seam. They are an **internal SDK transport contract**, deliberately _not_ part
   of `@uptimizr/schema` (the wire contract stays unchanged — ADR 0031 §7, ADR 0003). Channels:
   `camera`, `perf`, `node` (Tier-1 nodes + Tier-2 bones), `visibilityTick` / `visibilityFlush`,
   `gesture`, `hover`.

2. **The Aggregator finalizes the events.** It consumes the snapshot DTOs and produces the finalized
   `@uptimizr/schema` events, running the percentiles, matrix decomposition, visibility bucketing,
   idle-diffing and gesture classification that used to live in each connector — using the **same
   pure functions** (`decomposeWorldMatrix`, `classifyCameraGesture`, and the percentile / visibility
   / idle-diff helpers extracted into `@uptimizr/sdk-core`). It holds no engine or DOM handle, so the
   _same instance logic_ runs unchanged on the main thread (default) or inside the offload worker
   (opt-in). There is no worker-only fork (ADR 0031 §2).

3. **Two execution locations behind the existing flag.** `offload: "main"` runs the aggregator
   synchronously → `client.emit` → existing queue/flush — byte-for-byte identical to before.
   `offload: "worker"` posts the snapshots (transferable, zero-copy for the typed-array channels) to
   the worker, which hosts an aggregator and dispatches the finalized events. The aggregation worker
   is **separate from the transport processor's worker** so the existing transport seam and its tests
   stay untouched; both load the same `offloadWorker` module and act only on the messages they
   receive.

4. **Gaze raycast keeps a main-thread idle pre-gate.** The gaze `pickWithRay` (ADR 0030) only runs
   _after_ the camera idle-diff passes, so at most one pick happens per emitted pose and none while
   the view is static. Idle-diff is offload-eligible, but here it gates a main-thread engine read.
   Resolution: the connector keeps a cheap main-thread pre-gate calling the **same** extracted
   `poseUnchanged` pure function (no logic fork), then snapshots; the aggregator's `camera` channel is
   a pass-through. The hover dwell-threshold gate stays in the connector for the same reason (it gates
   episode bookkeeping); the aggregator's `hover` channel is also pass-through.

5. **Decompose moves only where the engine matrix is already canonical.** The aggregator's matrix
   path uses `decomposeWorldMatrix` with **no handedness conversion**. So a connector passes a raw
   `matrix` (moving the decompose into the aggregator/worker) **only** when its source matrix is a
   canonical-frame, column-major buffer that decomposes identically — Babylon bones are the case.
   Where a connector applies an axis/handedness conversion to the canonical frame (ADR 0018) —
   three.js `matrixWorld`, PlayCanvas world reads — or where the engine already exposes a decomposed
   transform (Babylon world nodes), the connector keeps its engine-specific decompose and passes a
   pre-decomposed `decomposed` sample. The aggregator then performs only the idle-diff. This keeps
   output byte-for-byte while still removing the high-volume idle-diff / percentile / visibility /
   gesture math (and, where safe, the decompose) from the connectors.

6. **Unload stays main-thread and is drained.** Worker-resident aggregation windows must survive the
   terminal flush. On `client.stop()` the connector posts its final flush snapshots, then the client
   awaits a worker drain round-trip so all finalized events are queued before the main-thread
   unload `sendBeacon` (ADR 0031 §5, ADR 0006). `visibilitychange: hidden` best-effort drains; a hard
   `pagehide` may lose ≤1 partial window — the same loss profile ADR 0031 already accepts.

## Consequences

### Positive

- The duplicated aggregation math now lives **once** in `@uptimizr/sdk-core`; connectors shrink to
  engine reads + snapshot emits, so a fix or new channel is written and tested in one place.
- With `offload: "worker"`, the per-frame percentile / decompose / visibility / gesture / idle-diff
  work leaves the render thread along with serialization — the heavy profiles ADR 0012 allows (dense
  bone capture, large visibility sets) get a real pressure valve.
- No default-behaviour change and no correctness dependency on the flag: every connector's existing
  unit tests pass unchanged by routing snapshots through a real main-thread aggregator in the test
  context — the byte-for-byte guard.
- The wire contract (`@uptimizr/schema`) and privacy model (ADR 0003) are untouched; this is an
  execution-location change only.

### Negative / trade-offs

- A connector that converts handedness cannot offload its decompose; that math stays in the
  (cheap, per-node) snapshot phase. Full decompose offload is realized only for canonical-frame
  matrices (Babylon bones).
- The snapshot DTOs are a new internal contract to keep in step with `@uptimizr/schema` event shapes;
  the aggregator is the single place that bridges them and must reproduce each emit exactly.
- A second (aggregation) worker and the snapshot `postMessage` traffic add states to test (main vs
  worker, transferable neutering, unload drain, fallback) — covered by sdk-core tests.

## Alternatives considered

- **Per-engine aggregators (one per connector).** Rejected: it preserves the duplication this ADR
  removes and invites drift between connectors. A single engine-agnostic aggregator consuming a
  uniform DTO is the whole point.
- **Always pass a raw matrix and convert handedness inside the aggregator.** Rejected: it would push
  engine-specific frame knowledge into the engine-agnostic core (or add a handedness field to the
  DTO and a conversion fork), risking byte-for-byte drift. Pre-decomposing in the connector that owns
  the convention is simpler and provably identical.
- **Reuse the transport processor's worker for aggregation.** Rejected for now: it would entangle the
  aggregation seam with the transport seam and its tests. A dedicated aggregation worker keeps the
  two seams independent; sharing a worker can be revisited as an optimization.
- **Drop idle-diffing on the main thread entirely (offload it too) for the gaze channel.** Rejected:
  idle-diff there gates a main-thread `pickWithRay`; deferring it to the worker would either run the
  pick every frame or require a round-trip before each pick. A cheap main-thread pre-gate using the
  same pure function preserves today's "≤1 pick per emitted pose" behaviour.
