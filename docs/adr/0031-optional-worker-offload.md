# ADR 0031: Optional Web Worker offload of client-side processing

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Uptimizr maintainers

## Context

The SDK runs alongside a live 3D scene that already owns the main thread for rendering. Any CPU
the collector spends there competes directly with the render loop, so a heavy or badly-configured
profile can cost the host frames. We want to let an integrator **offload as much SDK processing as
possible to a Web Worker, if they choose to** — strictly opt-in, with conservative main-thread
defaults unchanged.

The naive framing ("move the SDK to a worker") does not work, because the SDK's work is not one
homogeneous blob. It splits cleanly into two phases:

1. **Snapshot (must be main-thread).** Reading live engine state — frustum tests,
   `getBoundingInfo()`, `pickWithRay()` gaze rays, `computeWorldMatrix()`, pointer/keyboard
   observers, `engine.getFps()`. Babylon's scene graph and the WebGL/WebGPU context live on the
   main thread; a `Mesh` is not transferable and its state is not reachable from a worker. This
   phase **cannot** move. Importantly, on its own it is also **cheap** — mostly property reads and
   an array push per frame.

2. **Processing (offload-eligible).** Once a snapshot is plain numbers, the rest is pure
   number-crunching over plain data, with no engine or DOM handles:
   - Frame-time **percentiles** (p95/p99 via sort over the window) —
     [`percentileAsc()`](../../oss/packages/sdk-babylon/src/collector.ts).
   - **Camera-gesture classification** (vector/angle math) —
     [`classifyCameraGesture()`](../../oss/packages/sdk-core/src/gesture.ts), already pure and
     engine-free.
   - **Matrix → position/quaternion/scale decomposition** for node/bone transforms (ADR 0027) —
     the quaternion-extraction math in
     [`collector.ts`](../../oss/packages/sdk-babylon/src/collector.ts).
   - **Mesh-visibility aggregation** — the dot-product/screen-fraction math and per-window
     bucketing (ADR 0012) that turns per-frame reads into one event per object per window, plus
     AABB dedupe/rounding (#53).
   - **Idle-diffing** — comparing a fresh pose against the last emitted one within an epsilon.
   - **Serialization + dispatch** — `JSON.stringify` of the batch and the `sendBeacon`/`fetch`
     call in [`createBeaconTransport()`](../../oss/packages/sdk-core/src/transport.ts), behind the
     existing batching in [`UptimizrClient`](../../oss/packages/sdk-core/src/client.ts).

Per signal these costs are small today (microseconds). They matter in three situations the dial in
[ADR 0012](./0012-sampling-and-fidelity.md) deliberately allows: per-frame bone capture (e.g. 60
bones × 60 fps decompositions), large flush batches stringified in one main-thread span, and dense
mesh-visibility profiles. For those, the integrator should be able to push the **processing** phase
off the render thread. This ADR records _that capability and its boundary_; it does not change
default behaviour and does not, by itself, attack per-frame snapshot cost (sampling cadence and a
future frame-budget scheduler remain the levers for that).

This ADR is design-only. It defines the seam, the contract, and the boundary; no implementation is
included.

## Decision

Add an **optional, opt-in worker mode** that relocates the offload-eligible _processing_ phase off
the main thread, governed by one principle: **the main thread only snapshots; everything that can
run on plain data may run in a worker.**

**The entire feature is opt-in, default off, and a no-op when absent.** This is the headline
guarantee, not an implementation detail:

- The default is `offload: "main"` — today's synchronous main-thread behaviour, byte-for-byte.
  Worker mode is reached only by an explicit flag.
- **Correctness never depends on the flag.** Not enabling it, or running where workers are
  unavailable (older embeds, restrictive CSP, SSR, tests), yields identical output via the
  main-thread processor. The flag is purely a performance valve.
- It changes **execution location only** — never _what_ is computed or _what_ is sent. No data
  collection is added or removed, so there is no privacy-relevant choice to consent to (ADR 0003,
  `@uptimizr/schema` unchanged).

1. **Formalize the snapshot ↔ processing boundary as a plain-data DTO.** Connectors produce
   engine-free **snapshot records** (tuples/arrays of numbers, ids, timestamps) on the main thread.
   Everything downstream — aggregation, percentile, gesture/transform math, idle-diffing,
   serialization, transport — consumes only those DTOs. This boundary is the contract that makes
   offload possible and must be kept clean (no engine handles cross it).

2. **Keep the processing functions isomorphic and pure.** The math already lives in pure,
   engine-agnostic functions (gesture classifier in `@uptimizr/sdk-core` is the model). The same
   function runs unchanged on the main thread or inside a worker; worker mode changes _where_ it
   runs, never _what_ it computes. No worker-only forks of logic.

3. **Introduce a pluggable processing seam, mirroring the transport seam.** A `Processor` abstraction
   sits between capture and transport. The default is a synchronous main-thread processor (today's
   behaviour, byte-for-byte). An opt-in `createWorkerProcessor()` posts snapshot DTOs to a worker
   that performs aggregation + serialization + network dispatch and returns only acknowledgements.
   This reuses the existing seam philosophy of
   [`createBeaconTransport()`](../../oss/packages/sdk-core/src/transport.ts).

4. **Opt-in, off by default, with graceful fallback.** Worker mode is a single config flag (e.g.
   `offload: "worker"`, default `"main"`). If `Worker`/module workers are unavailable (older
   embeds, restrictive CSP, SSR, test envs) the SDK silently falls back to the main-thread
   processor. Turning the flag on must never be required for correctness — it is purely a
   performance valve.

5. **Move network dispatch into the worker when worker mode is on.** `JSON.stringify` and the
   `fetch`/`sendBeacon` call run in the worker, so large-batch serialization never blocks a frame.
   **Exception — unload flushes stay on the main thread:** `sendBeacon` semantics on
   `visibilitychange: hidden` / `pagehide` are only reliable from the page context, so the final
   flush (ADR-0006 replay-completeness) bypasses the worker. The worker handles steady-state
   batches; the main thread guarantees the last one.

6. **Minimize copy cost with transferables.** Snapshot DTOs are designed to be cheap to ship —
   prefer transferable `ArrayBuffer`/typed-array windows (e.g. the frame-time ring) over structured
   clone of large object graphs where it matters. Small discrete events may be plain structured
   clone; the high-volume continuous channels are the ones worth packing.

7. **Same-origin, no new data, no new surface.** The worker is a same-origin module worker bundled
   with the SDK. It receives exactly the data the SDK already sends and emits nothing new — no
   change to the privacy model (ADR 0003) or the wire contract (`@uptimizr/schema`). Worker mode is
   an execution-location choice, not a data-collection change.

8. **OSS-pluggable.** Both the processor and transport seams stay public so self-hosters can supply
   their own (e.g. a SharedWorker shared across iframes, or a custom transport). The seams stay
   within the self-contained OSS workspace (ADR 0004).

### What can and cannot be offloaded

| Work                                                                               | Phase      | Worker-eligible                            |
| ---------------------------------------------------------------------------------- | ---------- | ------------------------------------------ |
| Frustum/visibility reads, `pickWithRay`, `computeWorldMatrix`, FPS read, observers | Snapshot   | **No** — engine state is main-thread-only  |
| Per-frame frame-time push                                                          | Snapshot   | No (trivial; stays where the read is)      |
| Percentile (p95/p99) computation                                                   | Processing | **Yes**                                    |
| Camera-gesture classification                                                      | Processing | **Yes**                                    |
| Matrix → pos/quat/scale decomposition                                              | Processing | **Yes**                                    |
| Mesh-visibility aggregation + AABB dedupe/round                                    | Processing | **Yes** (the math; the reads stay)         |
| Idle-diffing                                                                       | Processing | **Yes**                                    |
| `JSON.stringify` + steady-state `fetch`/`sendBeacon`                               | Processing | **Yes**                                    |
| Final unload flush                                                                 | Processing | **No** — reliability requires page context |

## Consequences

### Positive

- Heavy/per-frame profiles (bone capture, dense visibility, large batches) get a real pressure
  valve: the number-crunching and serialization spikes leave the render thread.
- No default-behaviour change and no correctness dependency on the flag; conservative defaults
  (ADR 0012) stand.
- The clean snapshot DTO boundary is good hygiene regardless of workers — it sharpens the
  capture/compute split and keeps connectors thin.
- Reuses the established transport-seam pattern; the worker is "just another processor."

### Negative / trade-offs

- A second execution context adds bundle size, a build step for the worker module, and more states
  to test (worker present/absent, fallback, unload path).
- `postMessage`/structured-clone (or transfer) has its own cost; for light default profiles it can
  cost _more_ than it saves, which is exactly why it is opt-in, not default.
- Two flush paths (worker steady-state + main-thread unload) is extra complexity that must be
  covered by tests to preserve replay-completeness (ADR 0006).
- Requires keeping all processing functions strictly pure/isomorphic — a constraint future
  contributors must respect or the seam rots.

## Alternatives considered

- **Move the whole SDK (including capture) into a worker.** Impossible: engine/scene/GPU state is
  main-thread-bound and not transferable. Capture must stay on the main thread.
- **Worker on by default.** Rejected: for the conservative default profile the copy overhead can
  exceed the savings, and it expands the always-on surface (CSP, SSR, embeds). Performance valves
  should be opt-in.
- **OffscreenCanvas.** Not applicable — the SDK reads scene state, it does not render.
- **Do nothing; rely only on the sampling dial (ADR 0012) and a frame-budget scheduler.** These
  remain the primary levers for _snapshot_ cost and are complementary, but they cannot relocate the
  _processing/serialization_ spikes that a worker can. This ADR adds the offload option without
  displacing those levers.
- **A dedicated worker-only reimplementation of the math.** Rejected: forking logic per execution
  context invites drift. The same pure functions must serve both.
