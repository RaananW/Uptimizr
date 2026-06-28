---
title: Custom events & input
description: Record your own domain events, capture keyboard/gamepad input actions, report capability fallbacks, and switch scenes within a session.
---

The built-in channels cover pointer, camera, mesh, and performance. These APIs let your app contribute
the rest of the picture — domain events, non-pointer input, capability fallbacks, and scene changes.
All of them are methods on the client returned by `trackScene(...)`.

## Custom events

Record your own discrete domain events. They're always captured at 100% — never rate-limited.

```ts
const client = trackScene(scene, { projectId, endpoint });

client.track("add_to_cart", { sku: "ABC-123", price: 49 });
```

Keep the property map free of PII. Read per-type counts from
`GET /api/v1/event-counts`.

## Input actions (keyboard, gamepad, XR)

Mouse and touch are captured automatically as pointer events. Discrete **input actions** from other
devices — keyboard shortcuts, gamepad buttons, XR controller buttons — are recorded as `input_action`
events. Each carries a semantic `action` label (what the input _did_) plus the originating
`source` and the raw `code`/`button` token.

Emit one explicitly whenever you handle a binding:

```ts
// In your own keydown / gamepad handler:
client.trackInput("next-camera", { source: "keyboard", code: "KeyN", pressed: true });
client.trackInput("jump", { source: "gamepad", button: 0 });
```

`source` defaults to `"keyboard"`. These events are discrete and always captured at 100%.

### `keyBindings` allowlist

The Babylon, three.js, and PlayCanvas connectors can capture bound keys for you. Pass
`keyBindings` mapping a physical `KeyboardEvent.code` to an action label — **only** the
listed keys are recorded (privacy-first), arbitrary typing is never captured, and
auto-repeat is suppressed:

```ts
trackScene(scene, {
  projectId,
  endpoint,
  keyBindings: { KeyW: "move-forward", KeyS: "move-back", Space: "jump" },
});
```

three.js / PlayCanvas (and react-three-fiber via `@uptimizr/r3f`) accept the same
option. They have no keyboard observable, so they listen on `window` — handy for
pointer-lock / FPS scenes where the canvas rarely holds focus.

## Capability changes (fallbacks & recovery)

Rendering capability isn't constant: some visitors run WebGPU, others fall back to WebGL2; weaker
devices auto-downgrade quality/LOD; a lost GPU device may re-initialise at a different capability.
These transitions otherwise look like unexplained noise in aggregate metrics.

Engines decide their backend at init and expose no reliable runtime hook, so connectors do **not**
auto-capture this — report it from your app whenever you perform a fallback or recovery:

```ts
// after a WebGPU init fails and you fall back:
client.reportCapabilityChange({ kind: "graphics-backend", from: "webgpu", to: "webgl2" });
// or a runtime quality/LOD auto-downgrade:
client.reportCapabilityChange({ kind: "quality", from: "high", to: "low", reason: "low-fps" });
```

`kind` is one of `graphics-backend` / `quality` / `device-recovery` / `feature` / `other`; `from` /
`to` / `reason` are optional, low-cardinality, app-defined tokens (never raw device strings or PII).
This pairs with the raw [`context_lost` / `context_restored`](/docs/guides/sessions/#engine--browser-lifecycle-events)
events — it's the higher-level "what we ran as" signal. Read the rollup from `GET /api/v1/capabilities`.

## Engine diagnostics (opt-in GPU health)

`graphics_diagnostic` carries engine-authored GPU-health signals — GPU errors/warnings,
shader-compile/link failures, richer context-loss reasons, WebGPU `uncapturederror`, and sampled
`gl.getError()` — in one engine-agnostic shape (`severity`, `category`, optional `backend`,
length-capped `message`/`code`, and a `count` rollup-or-marker discriminator).

It is **off by default** and gated by the `captureGraphicsDiagnostics`
[option](/docs/guides/configuration/) — like `runtime_error`, the text can leak application IP, so
you opt in and redact via `beforeSend`. The default emission is a rate-limited per-session rollup so
an error storm can't flood ingestion. `context_lost` / `context_restored` are exempt and stay
always-on; engine-driven backend fallback stays in `capability_change` above.

Once captured, these incidents surface in the dashboard's **Engine diagnostics** panel — counts by
severity, category, and backend — backed by `GET /api/v1/graphics-diagnostics`, which folds discrete
markers and per-session rollups into one honest total. With capture off, the panel shows an explicit
opt-in empty state rather than reading as broken.

> **Wired today:** WebGPU `device.lost` → `graphics_diagnostic` (`category: device-lost`) in the
> Babylon (`@uptimizr/babylon`) and three (`@uptimizr/three`) connectors. `severity` is `info` for a
> requested loss (`reason: "destroyed"`) and `fatal` for an unrequested one; the optional `message`
> is length-capped and runs through `beforeSend`. WebGL renderers are a no-op (their interruption is
> the always-on `context_lost`). Other signals (`uncapturederror`, context-creation failure,
> shader-compile failures) land incrementally in later releases.

## Changing scenes / levels (`setScene`)

A single session can span multiple scenes, areas, or levels — game levels, a viewer swapping models,
or a multi-room walkthrough. You do **not** stop and restart tracking when the visitor moves between
them; you keep one client alive and mark the transition:

```ts
const client = trackScene(scene, {
  projectId,
  endpoint,
  meta: { sceneId: "level-1" }, // initial scene/area
});

client.setScene("level-2"); // when the next scene loads
```

See the [multi-scene experiences guide](/docs/guides/multi-scene/) for the full patterns
(levels, viewers, rooms), per-scene querying, and how replay crosses scene changes.
