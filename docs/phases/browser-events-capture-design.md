# Design sketch — full browser & runtime event capture

> **Status:** Mutable design notes (not an ADR). Captures the plan to make the tracker report a
> _complete_ picture of what happens to the canvas/app — not just pointer, camera, and perf.
> The durable parts (new event shapes, the privacy stance for error capture) graduate to the
> [event schema](../../oss/packages/schema) and, where a decision is hard to reverse, to a new ADR.
> See [phase plans](./README.md). Nothing here is committed to a phase yet.

## Problem

Today the SDK only captures _intent and performance_ signals from inside the scene
(`pointer_*`, `camera_sample`, `mesh_interaction`, `frame_perf`, `custom`, plus the
`session_*` / `scene_change` markers). The host **document/window** lifecycle is almost
invisible: [`sdk-core` `bindLifecycle()`](../../oss/packages/sdk-core/src/client.ts) only wires
`visibilitychange` (flush) and `pagehide` (end session). That leaves blind spots that routinely
explain "the scene looked broken / nothing rendered":

- The canvas was **resized** (heatmap/screen coordinates were captured at a different viewport).
- The tab/window lost **focus** or **visibility**, so the render loop throttled or stopped.
- A JavaScript **error** or unhandled rejection broke the frame loop.
- The WebGL/WebGPU **device was lost** (the single most common silent scene death).

The goal: the tracker provides _feedback on what is happening in the scene in full_, so a replay /
debugging session can explain gaps instead of leaving them unexplained.

## Design principles (carried from AGENTS.md / ADRs)

- **Events live once** in `@uptimizr/schema` (Zod). New events are engine-neutral; the Babylon
  adapter maps Babylon observables onto them so future connectors (three.js, PlayCanvas) reuse
  the same shapes.
- **Replay-complete:** every new event is ordered, timestamped, `sessionId`-keyed, and gets a
  handler (visual or no-op) in the replay driver so the timeline stays complete.
- **Privacy first (ADR 0003):** error text can leak PII/URLs. Capture must be conservative by
  default and run through `beforeSend`.
- **Fidelity/sampling (ADR 0012):** high-frequency signals (resize) are debounced; they fit the
  existing per-channel fidelity model.
- **Thin core:** generic DOM lifecycle binding lives in `sdk-core`; engine-specific signals
  (context loss) live in `sdk-babylon`.

## Proposed event catalog

Each row is added end-to-end via the [`add-event-type`](../../.github/skills/add-event-type)
flow: Zod schema → `sdk-core`/`sdk-babylon` emit → collector ingest (generic `payload` column,
no migration) → replay handler → tests → `docs/integration.md`.

| Event               | Origin                                                | Payload (beyond the envelope)                       | Default | Why it matters                                                                                                             |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `viewport_resize`   | `window` `resize` / `ResizeObserver` on the canvas    | `width`, `height`, `dpr`                            | on      | 2D pointer/screen coords are only meaningful relative to the viewport they were captured in; needed to normalize heatmaps. |
| `visibility_change` | `visibilitychange`                                    | `state: "visible" \| "hidden"`                      | on      | Explicit timeline marker for tab backgrounding (render loop throttles/stops).                                              |
| `focus_change`      | `window`/canvas `focus`/`blur` (`focusin`/`focusout`) | `focused: boolean`                                  | on      | Correlates render gaps with the canvas losing focus (the original question).                                               |
| `runtime_error`     | `window.onerror` + `unhandledrejection`               | `message`, `source?`, `lineno?`, `colno?`, `stack?` | opt-in  | Surfaces JS errors that break the scene — core "what is happening" feedback.                                               |
| `context_lost`      | Babylon `onContextLostObservable`                     | —                                                   | on      | WebGL/WebGPU device loss; the scene goes blank with no other signal.                                                       |
| `context_restored`  | Babylon `onContextRestoredObservable`                 | —                                                   | on      | Pairs with `context_lost` to bound the outage on the timeline.                                                             |

Optional / later: `engine_warning` (Babylon engine log / validation failures, `message`), and a
`page_blur`-style coarse window blur if canvas-level focus proves noisy.

### Why `visibility_change` is a real event, not just a flush hook

`visibilitychange` already triggers a queue flush in `sdk-core`. Promoting it to an ordered event
makes the _gap itself_ visible on the replay timeline (and lets the dashboard explain a flat
stretch of FPS or a missing camera path), instead of only affecting delivery.

## Component-by-component plan

1. **`@uptimizr/schema`** — add the six Zod object schemas, extend `anyEventSchema`, export
   types. Keep payloads minimal and engine-neutral. Error fields all optional; cap `stack` length
   in the schema (e.g. `.max(2000)`).
2. **`@uptimizr/sdk-core`** — extend `bindLifecycle()` with `resize` (debounced, trailing ~250ms),
   `focus`/`blur`, and the `error`/`unhandledrejection` handlers behind a config flag
   (`captureErrors`, default off). Promote `visibilitychange` to also emit `visibility_change`.
   Add a `scrubError?(info) => info | null` hook (or rely on the existing `beforeSend`) so hosts
   can redact. All new listeners are removed in `unbindLifecycle()`.
3. **`@uptimizr/babylon`** — in the collector, subscribe to `engine.onContextLostObservable` /
   `onContextRestoredObservable` and emit `context_lost` / `context_restored`; optionally back the
   `viewport_resize` channel with `engine.onResizeObservable` for canvas-accurate dimensions.
   Thread new capture toggles through `BabylonCaptureOptions` / `TrackSceneOptions`.
4. **Collector** — no schema migration needed (events flow through the generic `payload` column);
   confirm ingestion validates and stores them, and they appear in `getSessionEvents`.
5. **`@uptimizr/replay`** — add driver handling: `viewport_resize` can resize the replay canvas or
   annotate; `context_lost`/`error`/`focus`/`visibility` surface via new optional host callbacks
   (`onContextLost`, `onError`, `onFocusChange`, `onVisibilityChange`) so a host can render markers.
   No event may be silently dropped.
6. **Tests** — `sdk-core` unit tests (debounce, listener add/remove, error scrubbing,
   visibility promotion), `sdk-babylon` context-loss emission, `replay` driver dispatch.
7. **Docs** — extend [`docs/integration.md`](../integration.md) tracking-options and event tables.

## Privacy decision to lock before coding (needs an ADR note)

> **Resolved.** The privacy stance below was ratified in
> [ADR 0013 — Error-capture privacy](../adr/0013-error-capture-privacy.md), and
> `runtime_error` shipped in PR B (off by default, `captureErrors`, bounded payload,
> `beforeSend` redaction, storm dedupe + 50/session cap).

`runtime_error` is the only new event that can carry PII (messages, stack frames, file URLs with
query strings). Proposed stance to record as an ADR or an addendum to ADR 0003:

- **Default off.** Enabled via `captureErrors: true`.
- When on: capture `message` + truncated `stack`; **never** capture arbitrary local variables.
- Run every error event through `beforeSend` / a `scrubError` hook before it enters the queue.
- Document that enabling error capture is the developer's responsibility w.r.t. their privacy
  posture.

## Suggested sequencing

- **PR A — lifecycle & viewport (low risk, high value):** ✅ shipped. `viewport_resize`,
  `focus_change`, `visibility_change`, plus `context_lost`/`context_restored` (Babylon) and
  replay handling + docs.
- **PR B — error health:** ✅ shipped. Opt-in `runtime_error` per ADR 0013.

## Open questions

- Canvas-level `focusin/focusout` vs window `focus/blur` — which best matches "the canvas isn't
  displayed right now"? (Likely both: window blur is coarser; canvas focus is precise.)
- Should `viewport_resize` emit an initial sample at `session_start` so every session has a known
  starting viewport? (Leaning yes — it makes heatmap normalization unconditional.)
- Do we fold `visibility_change` + `focus_change` into one `attention_change` event, or keep them
  distinct? (Leaning distinct: they answer different questions and have different sources.)
