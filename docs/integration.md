# Integration & API reference

How to **track** a 3D scene, **replay** a captured session, and **query** the
collected analytics. This is the consumer-facing reference; for design rationale
see the [ADRs](./adr), and for package-level detail see each package README.

Two packages matter for integration, and they are deliberately separate:

| Package                                                        | Role                                                                                | Where it runs              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| [`@uptimizr/babylon`](../oss/packages/sdk-babylon/README.md)   | **Collector** — reads a Babylon.js scene, writes events                             | every visitor (production) |
| [`@uptimizr/three`](../oss/packages/sdk-three/README.md)       | **Collector** — reads a three.js scene, writes events                               | every visitor (production) |
| [`@uptimizr/web-export`](../oss/packages/web-export/README.md) | **Foundation** — JS-only tier + versioned bridge for Unity/Godot/Unreal web exports | every visitor (production) |
| [`@uptimizr/replay`](../oss/packages/replay/README.md)         | **Replay** — reads events, re-drives the scene, emits nothing                       | the developer (dev/debug)  |

The collector is intentionally tiny so it can ship to every visitor. Replay is an
optional developer tool you run in your own environment; it never emits analytics
(ADR 0006), so it is not bundled into the collector.

The examples below use the Babylon connector; the three.js connector mirrors the
same API (`trackScene` + options) — see its
[README](../oss/packages/sdk-three/README.md) for the few three-specific
arguments (`camera`, `renderer`).

> **Web-export engines (Unity, Godot, Unreal).** Engines that compile to WebAssembly
> and render into a `<canvas>` have no live JS scene to read, so they don't use
> `trackScene`. They share the [`@uptimizr/web-export`](../oss/packages/web-export/README.md)
> foundation and capture in **two tiers**: a **JS-only tier** (pointer heatmaps, FPS,
> JS errors — no engine code) that is live from `trackUnity` / `trackGodot` /
> `trackUnreal`, and a **bridged tier** (camera pose, world-space picks, replay) driven
> by a thin engine-side **copy-in shim** that pushes world-space samples over a
> versioned bridge. The engine is **not** an npm peer dependency. Each engine package
> ships the shim as a copy-in asset — e.g. `@uptimizr/godot` includes a `JavaScriptBridge`
> autoload (`bridge/UptimizrGodot.gd` / `.cs`) you register in **Project Settings →
> Autoload**. See the
> [web-export connector docs](https://uptimizr.dev/connectors/web-export) for the
> bridge contract and per-engine native frames.

---

## 1. Track

### Option A — npm (your own build)

```bash
npm install @uptimizr/babylon
# @babylonjs/core is a peer dependency — the connector reads your Babylon instance.
```

```ts
import { trackScene } from "@uptimizr/babylon";

const client = trackScene(scene, {
  projectId: "your-project-id",
  endpoint: "https://collect.example.com",
  meta: { sceneId: "product-configurator" },
});

// On teardown:
await client.stop("manual");
```

`trackScene` returns the [`UptimizrClient`](../oss/packages/sdk-core/README.md),
so you can read `client.sessionId`, emit custom events, or `stop()` on unmount.

### Option B — `<script>` tag (no build step)

For environments where you can't run a bundler (e.g. the Babylon Playground), use
the global IIFE build, which exposes `window.Uptimizr`. Injecting a `<script>`
through the DOM also sidesteps any TypeScript/`import` rewriting on the host page.

```js
const s = document.createElement("script");
s.src = "https://collect.example.com/uptimizr-babylon.global.js";
s.onload = () => {
  Uptimizr.trackScene(scene, {
    projectId: "your-project-id",
    endpoint: "https://collect.example.com",
    meta: { sceneId: "playground" },
  });
};
document.head.appendChild(s);
```

> `pnpm playground` prints this snippet pre-filled with a local project id and a
> tunnel/localhost endpoint. See [run-local-stack](../.github/skills/run-local-stack/SKILL.md).

### Custom events

Beyond the built-in channels, record your own domain events. Custom events are
discrete and always captured at 100% — they are never rate-limited.

```ts
client.track("add_to_cart", { sku: "ABC-123", price: 49 });
```

### Input actions (keyboard, gamepad, …)

Mouse and touch are captured automatically as pointer events. Discrete **input
actions** from other devices — keyboard shortcuts, gamepad buttons, XR controller
buttons — are recorded as `input_action` events (ADR 0023). Each carries a
semantic `action` label (what the input _did_) plus the originating `source` and
the raw `code`/`button` token, so the timeline reflects non-pointer input the same
way it reflects clicks.

Emit one explicitly whenever you handle a binding:

```ts
// In your own keydown / gamepad handler:
client.trackInput("next-camera", { source: "keyboard", code: "KeyN", pressed: true });
client.trackInput("jump", { source: "gamepad", button: 0 });
```

`source` defaults to `"keyboard"`. `input_action` events are discrete and always
captured at 100%.

The Babylon, three.js, and PlayCanvas connectors can capture bound keys for you via
an **allowlist** — pass `keyBindings` mapping a physical `KeyboardEvent.code` to an
action label. Only the listed keys are recorded (privacy-first, ADR 0003); arbitrary
typing is never captured, and auto-repeat is suppressed:

```ts
trackScene(scene, {
  projectId: "your-project-id",
  endpoint: "https://collect.example.com",
  keyBindings: { KeyW: "move-forward", KeyS: "move-back", Space: "jump" },
});
```

> three.js / PlayCanvas (and react-three-fiber via `@uptimizr/r3f`) pass the same
> `keyBindings` option. three has no keyboard observable, so those connectors listen
> on `window` — handy for pointer-lock / FPS scenes where the canvas rarely holds
> focus. The default playground bindings cover **WASD + arrow keys** plus the demo's
> own camera-cycle / jump keys.

### Capability changes (fallbacks & recovery)

Rendering capability isn't constant across your user base: some visitors run on
WebGPU, others fall back to WebGL2; weaker devices auto-downgrade quality or LOD; a
lost GPU device may be re-initialised at a different capability. These transitions
otherwise look like unexplained noise in the aggregate perf/heatmap metrics.

Engines decide their backend at init and expose no reliable runtime hook, so the
connectors do **not** auto-capture this — report it from your app with
`reportCapabilityChange` whenever you perform a fallback or recovery (#49):

```ts
// e.g. after Babylon's WebGPU engine init fails and you fall back:
client.reportCapabilityChange({ kind: "graphics-backend", from: "webgpu", to: "webgl2" });
// or a runtime quality/LOD auto-downgrade:
client.reportCapabilityChange({ kind: "quality", from: "high", to: "low", reason: "low-fps" });
```

`kind` is one of `graphics-backend` / `quality` / `device-recovery` / `feature` /
`other`; `from` / `to` / `reason` are optional, low-cardinality, app-defined tokens
(never raw device strings or PII, ADR 0003). This pairs with the raw `context_lost`
/ `context_restored` events — it's the higher-level "what we ran as" signal. Read
the rollup from `GET /api/v1/capabilities`.

### Changing scenes / levels (`setScene`)

A single session can span multiple scenes, areas, or levels — you do **not** stop
and restart tracking when the visitor moves between them. Keeping one session
intact preserves the ordered, replay-complete timeline; starting a new session
instead would fragment the visit and break replay continuity.

Set the **initial** scene/area id with `meta.sceneId`, then call
`client.setScene(id)` each time the active scene/area changes (ADR 0010):

```ts
const client = trackScene(scene, {
  projectId: "your-project-id",
  endpoint: "https://collect.example.com",
  meta: { sceneId: "level-1" }, // initial scene/area
});

// Later, when the next level loads:
client.setScene("level-2");
```

`setScene`:

- emits an ordered `scene_change` marker (a discrete event, always captured at
  100%) so replay records the transition, and
- **stamps the new `sceneId` on every subsequent event** until the next call.

It is a no-op when the id is unchanged, and invalid ids are ignored (logged when
`debug` is on). You may call it **before** the session starts — the id is then
applied to `session_start` instead of emitting a marker. The same call works in
the `<script>`-tag form, since `Uptimizr.trackScene(...)` also returns the
client.

Per-scene analytics then come from the optional `scene` query param on the heatmap
and mesh endpoints (see [§4](#4-http-api)) — e.g. `?scene=level-2` to view a single
level.

### Session lifecycle (automatic end & `stop`)

The session **starts** automatically when you call `trackScene` (it invokes
`client.start()` for you). It also **ends** automatically:

- When the tab is closed or navigated away (`pagehide`), the client emits
  `session_end` (reason `"hidden"`) and flushes the final batch via
  `navigator.sendBeacon`, so no events are lost on exit.
- When the tab is merely backgrounded (`visibilitychange` → hidden), queued events
  are flushed immediately but the session stays open.

For normal page exits you don't have to do anything. Call `client.stop(reason)`
to end a session **explicitly** — e.g. when a single-page app unmounts the 3D view
without a page navigation:

```ts
await client.stop("manual");
```

`reason` is one of `"manual"` | `"hidden"` | `"unload"` | `"timeout"` (default
`"manual"`) and is recorded on `session_end` alongside `durationMs`. After `stop`
the client emits nothing further; call `trackScene` again to begin a new session.

### Browser & engine lifecycle events

So the timeline reflects everything happening around the scene — not just camera
and pointer activity — the SDK also records these discrete lifecycle events
(privacy-safe: dimensions, booleans, and enum states only):

| Event                 | Source              | When                                                                                                                                                                                                                                                   |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `viewport_resize`     | `sdk-core`          | Window resized (debounced) + once at session start.                                                                                                                                                                                                    |
| `focus_change`        | `sdk-core`          | Window gained/lost focus (`{ focused }`).                                                                                                                                                                                                              |
| `visibility_change`   | `sdk-core`          | Tab shown/hidden (`{ state: "visible" \| "hidden" }`).                                                                                                                                                                                                 |
| `context_lost`        | `@uptimizr/babylon` | Engine lost its GPU context (rendering suspended).                                                                                                                                                                                                     |
| `context_restored`    | `@uptimizr/babylon` | Engine recovered its GPU context.                                                                                                                                                                                                                      |
| `compile_stall`       | `@uptimizr/babylon` | Main-thread shader/pipeline compilation hitch (`durationMs`, `phase`).                                                                                                                                                                                 |
| `capability_change`   | _app-reported_      | Fallback/recovery transition (`kind`, `from`, `to`, `reason`) — e.g. WebGPU→WebGL2.                                                                                                                                                                    |
| `runtime_error`       | `sdk-core`          | Uncaught JS error / unhandled promise rejection (opt-in).                                                                                                                                                                                              |
| `graphics_diagnostic` | engine connector    | Opt-in GPU-health signal — today: WebGPU `device.lost` (`category: device-lost`), `uncapturederror` rollup (`validation`/`out-of-memory`), and context-creation failure (`category: context-loss`, `fatal`). Babylon + three; WebGL device-loss no-op. |

The generic browser events are captured by `sdk-core` and controlled by
`captureLifecycle` (default `true`); `viewport_resize` is debounced by
`resizeDebounceMs` (default `250`). The engine context-loss events are captured by
the Babylon connector and controlled by `capture.contextLoss` (default `true`).
Shader/pipeline `compile_stall` events (#42) are captured by the Babylon connector
and controlled by `capture.compileStall` (default `true`) — they time Babylon's
main-thread shader-compilation span, the #1 source of first-interaction hitches.
The three.js connector has no equivalent engine hook, so `compile_stall` is
Babylon-only.

`capability_change` events (#49) are **app-reported**, not auto-captured: engines
pick their backend at init and expose no reliable runtime "I downgraded" hook. When
your app falls back (WebGPU→WebGL2), auto-downgrades quality/LOD, or re-initialises
after a lost device, report the transition with
`client.reportCapabilityChange({ kind, from?, to?, reason? })` (`kind` is one of
`graphics-backend` / `quality` / `device-recovery` / `feature` / `other`). It pairs
with the raw `context_lost` / `context_restored` events and explains perf and
visual-fidelity variance across your user base. Pass low-cardinality, app-defined
tokens only — never raw device strings or PII (ADR 0003).
The session flush-on-hidden and end-on-`pagehide` behavior above is always active,
independent of `captureLifecycle`.

#### Error capture (opt-in)

`runtime_error` capture is **off by default** and gated by `captureErrors` (see
[ADR 0013](./adr/0013-error-capture-privacy.md)). When enabled, `sdk-core` listens
for `window` `error` and `unhandledrejection` and emits a `runtime_error` event:

```jsonc
{
  "type": "runtime_error",
  "kind": "error", // or "unhandledrejection"
  "message": "…", // ≤ 1024 chars
  "source": "https://app.example/main.js", // ≤ 1024 chars, optional
  "lineno": 42,
  "colno": 7,
  "stack": "…", // ≤ 4096 chars, optional
}
```

Error payloads can carry user data (messages, stack frames, URLs), so capture is
**opt-in** and **not auto-redacted**. Sanitize or drop fields in your
[`beforeSend`](#advanced-setup-custom-client-beforesend) hook before they leave the
browser. To limit
noisy loops, consecutive identical `message`+`stack` errors are de-duplicated and
capture is capped at 50 events per session.

#### Engine diagnostics (opt-in)

`graphics_diagnostic` capture is **off by default** and gated by
`captureGraphicsDiagnostics` ([ADR 0021](./adr/0021-graphics-backend-and-engine-diagnostics.md)).
It carries engine-authored GPU-health signals — GPU errors/warnings, shader-compile/link
failures, richer context-loss reasons, WebGPU `uncapturederror`, and sampled
`gl.getError()` — in one engine-agnostic shape:

```jsonc
{
  "type": "graphics_diagnostic",
  "severity": "error", // info | warning | error | fatal
  "category": "validation", // context-loss | validation | out-of-memory | shader-compile | device-lost | fallback
  "backend": "webgpu", // optional; reuses the graphics.api enum
  "message": "…", // optional, ≤ 1024 chars
  "code": "…", // optional, ≤ 64 chars (e.g. GL error / GPUError subtype)
  "count": 12, // optional: present ⇒ per-session rollup of N incidents; absent ⇒ one discrete marker
}
```

Like error capture, the text can leak application IP (shader source, driver
strings), so it is opt-in and **not auto-redacted** — sanitize via
[`beforeSend`](#advanced-setup-custom-client-beforesend). The default emission is a
rate-limited **per-session rollup** (`count` + first `message`) so an error storm can't
flood ingestion; discrete markers are the high-fidelity opt-in. `context_lost` /
`context_restored` are exempt and stay always-on, and the `fallback` category stays in the
app-reported `capability_change` event (it is reserved here, never emitted by a connector).

> Capture wiring per signal lands incrementally in the engine connectors. **Wired
> today** in the Babylon (`@uptimizr/babylon`) and three (`@uptimizr/three`) connectors:
> WebGPU `device.lost` → `category: device-lost` (`info` for a requested
> loss, `reason: "destroyed"`; `fatal` otherwise; WebGL is a no-op — its interruption is
> the always-on `context_lost`); WebGPU `uncapturederror` → rate-limited rollup
> (`category: validation` / `out-of-memory`, `count` + first `message`); WebGL/WebGPU
> **context-creation failure** → `category: context-loss` (`severity: fatal`, `backend: unknown`
> when undetermined; fires once at connector init and queues before the first flush); shader
> compile/link **failures** → `category: shader-compile` (`error`; WebGL
> `getShaderInfoLog`/`getProgramInfoLog` on failure, WebGPU shader-module `getCompilationInfo`);
> and sampled WebGL `gl.getError()` → `category: validation` (low-rate **rollup**, never per-frame
> — `getError` forces a sync GPU stall; no-op on WebGPU). **Shader source redaction:** the info log
> can embed shader source, so raw source is stripped unless the separate `captureShaderSource`
> sub-opt-in is set (off by default — application IP, ADR 0021).

### Session context (`meta`, `sceneDescription`, `user`)

`trackScene` attaches context to the one-time `session_start` event. `device` and
`scene` are auto-detected from Babylon; you supply the rest. The collector also
**derives a coarse `device.browser` / `device.os`** from the request User-Agent at
ingestion (e.g. `Chrome` / `Windows`) and merges them into the `device` block — a
non-PII, server-authoritative segment for the performance panels; the raw
User-Agent is never stored (ADR 0003 / ADR 0042). There are three
inputs, all optional:

- **`sceneDescription`** — a free-text label for the experience, merged into the
  auto-detected scene metadata.
- **`meta`** — page/area context: `sceneId` (initial scene/area id, ADR 0010),
  `url` (defaults to `location.href`), and `pageMeta`.
- **`user`** — caller-supplied, **anonymized** user context (see below).

```ts
const client = trackScene(scene, {
  projectId: "your-project-id",
  endpoint: "https://collect.example.com",

  // Free-text label for this experience.
  sceneDescription: "product-configurator",

  // Page / area context.
  meta: {
    sceneId: "configurator/step-1",
    url: location.href,
    pageMeta: { title: document.title },
  },

  // Anonymized user context — opt-in, never PII (see below).
  user: {
    id: hashedUserId, // pseudonymous/hashed, NOT an email or raw user id
    traits: { plan: "pro", returning: true },
  },
});
```

The same `sceneDescription` / `meta` / `user` fields work in the `<script>`-tag
form (`Uptimizr.trackScene(scene, { ... })`).

#### Adding an anonymized user

`user` is **opt-in** and Uptimizr never derives it — you pass it explicitly and
own the anonymization (ADR 0003):

- `user.id` MUST be pseudonymous or hashed — never an email, username, or raw
  account id. Omit it entirely to stay fully anonymous.
- `user.traits` is an open map of **non-identifying** values (`string` / `number`
  / `boolean` / `null`) for segmentation, e.g. `{ plan, locale, returning }`.

```ts
import { createHash } from "node:crypto"; // server-side; or hash before it reaches the client

const hashedUserId = createHash("sha256").update(`${rawUserId}:${dailySalt}`).digest("hex");

trackScene(scene, {
  projectId,
  endpoint,
  user: { id: hashedUserId, traits: { plan: "pro", locale: "en-US" } },
});
```

The user descriptor is surfaced per session at `GET /api/v1/sessions/:id/meta`.

### Advanced setup (custom client, `beforeSend`)

`trackScene` is the one-call path. For finer control — a custom transport, a
`beforeSend` hook to inspect/modify/drop events, or registering multiple
collectors on one session — build the [`UptimizrClient`](../oss/packages/sdk-core/README.md)
yourself and attach the Babylon collector with `client.use(...)`:

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { babylonCollector, readDeviceCaps, readSceneMeta } from "@uptimizr/babylon";

const client = new UptimizrClient({
  projectId: "your-project-id",
  endpoint: "https://collect.example.com",
  // Inspect, modify, or drop each event before it is queued. Return null to drop.
  beforeSend: (event) => (event.type === "pointer_move" ? null : event),
});

client.use(babylonCollector({ scene }));
client.start({ device: readDeviceCaps(scene), scene: readSceneMeta(scene) });

// Same API as the trackScene return value:
client.track("add_to_cart", { sku: "ABC-123" });
client.setScene("level-2");
await client.stop("manual");
```

`beforeSend` runs on every event after the envelope is filled in; use it to redact
fields or sample a noisy channel. It is **not** exposed through `trackScene` —
reach for the custom-client path when you need it.

### Privacy

No cookies, no persistent client id; the `sessionId` is in-memory only. Never put
PII in `meta`, `track` props, or `user` — `user.id` must be pseudonymous/hashed
(ADR 0003). Per-session raw event retention (needed for replay) is opt-in on the
collector via `ENABLE_RAW_SESSION_RETENTION=true`.

---

## 2. Tracking options (how to raise or lower the rate)

All options below are accepted by both `trackScene(scene, options)` and
`babylonCollector(options)`.

### Which camera is recorded (`camera`)

By default the view-direction / pose timeline records the engine's current active
camera. **For multi-camera scenes — picture-in-picture insets, split-screen, or
render-target rigs — set `camera` explicitly**, because the "active" camera is
ambiguous there and may resolve to a secondary/inset camera. Recording the wrong
camera produces a constant, incorrect pose: the gaze/view-direction heatmap
collapses to a single direction and replay starts from the wrong viewpoint.

```ts
trackScene(scene, {
  projectId,
  endpoint,
  camera: mainCamera, // the camera the viewer actually flies
});
```

If multiple cameras are active and `camera` is omitted, the SDK logs a one-time
console warning naming the camera it fell back to.

### Capture fidelity (`sampling`) — preferred

The `sampling` profile (ADR 0012) is a per-channel dial for the **continuous**
channels. Each rate is one of:

- a **positive number** — target rate in **Hz** (samples/second),
- `"frame"` — emit on every render tick (100% / per-frame),
- `0` — turn the channel off.

```ts
trackScene(scene, {
  projectId,
  endpoint,
  sampling: {
    camera: 10, // 10 Hz camera pose
    pointerMove: 60, // 60 Hz pointer movement
    perf: 0.5, // a perf sample every 2 s
    // perSource: { leftController: 30, rightHand: 30, gaze: 0 }, // XR (ADR 0011)
  },
});
```

There is **no enforced ceiling** — higher fidelity simply costs more storage.
Omitted channels keep the conservative defaults (≈1 Hz camera, ≈4 Hz pointer,
≈0.5 Hz perf). To capture _everything_, set the channel to `"frame"`.

**Discrete** events — `pointer_click`, `pointer_down`/`pointer_up`,
`mesh_interaction`, `scene_change`, `session_start`/`session_end`, `custom`,
`input_action`, `viewport_resize`, `focus_change`, `visibility_change`,
`context_lost`/`context_restored` — are always captured at 100% and cannot be
rate-limited.

### Scene actors (`actors` + `sampling.nodes` / `sampling.bones`) — opt-in

Replay re-drives the visitor's **own inputs**, but a scene often contains objects
that move on their **own** — an ambient NPC, a sliding door, an elevator, a
vehicle, a rigged character's wave. Those are driven by your app's
animation/AI/physics loop, not by the visitor, so by default the session has no
memory of where they were. Opt in to record them as `node_transform` events
(ADR 0027) and replay re-applies (does **not** re-simulate) their motion.

Capture is **off by default** and **allowlisted** — there is no "track
everything" switch. You declare a stable `nodeId` → engine-node mapping once via
`actors`, then dial each actor under `sampling`:

```ts
trackScene(scene, {
  projectId,
  endpoint,
  // Declare the developer-id → engine-node mapping once. Accepts a resolver
  // function (preferred — robust to load order/clones), an engine name/id
  // string the connector looks up, or a direct engine ref.
  actors: {
    "npc-guard": () => scene.getMeshByName("Guard_root"), // resolver (preferred)
    elevator: "Elevator.001", // engine name/id string
    "showroom-door": doorMeshRef, // direct engine ref
  },
  sampling: {
    // Tier 1 — node/root transform (world frame): locomotion + heading.
    nodes: {
      "npc-guard": 10, // Hz
      elevator: "frame",
      // unlisted actors: never tracked
    },
    // Tier 2 — skeleton bones (opt-in, skeleton-local; Babylon, three,
    // PlayCanvas). Higher cost & privacy; replay needs the same rig in the
    // target scene.
    bones: {
      "npc-guard": { include: ["mixamorig:RightHand", "mixamorig:LeftHand"], hz: 30 },
      // include: "*" => full rig (explicitly expensive); omit => no bone capture
    },
  },
});
```

`sampling.nodes` / `sampling.bones` keys MUST reference ids declared in `actors`;
an unknown id is a no-op with a dev-mode warning. Tier-1 transforms are sampled in
the canonical **world** frame; Tier-2 bone transforms are **skeleton-local** (the
only frame portable across differing world placements of the same rig). Idle
suppression applies — a static actor or an unmoving bone emits nothing.

> **`actors` is engine-typed.** Each connector adds `actors` to its own
> `TrackSceneOptions`, and the resolver's return type is that engine's node type:
> Babylon returns `AbstractMesh | TransformNode | null`
> (`scene.getMeshByName(…)`), three returns `Object3D | null`
> (`scene.getObjectByName(…)`), PlayCanvas returns `Entity | null`
> (`app.root.findByName(…)`). Tier-2 bone capture is supported on Babylon, three
> (a `SkinnedMesh`'s `skeleton.bones`), and PlayCanvas (a skinned entity's
> `skinInstance.bones`). The `babylon-lite` connector has no named-bone API
> (its skeleton is flat GPU-skinning data), so it supports Tier 1 only.

**Trackable node types** — the mechanism is "any node that exposes a world
transform," but _what may be tracked_ is a closed, normative list connectors
honor (ADR 0027 §7):

| Category                                       | Examples                                                                | Status                           | Notes                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Meshes / skinned-mesh root**                 | NPC body, door, vehicle shell, prop                                     | **In scope (Tier 1)**            | The common case; root transform = locomotion/heading.                                                        |
| **Transform-only nodes / groups / pivots**     | `TransformNode`, three `Object3D`/`Group`, empties, sockets, a rig root | **In scope (Tier 1)**            | Often the _preferred_ target: one stream drives a whole parented assembly. No geometry needed.               |
| **Skeleton bones**                             | `mixamorig:RightHand`, head bone                                        | **In scope (Tier 2, opt-in)**    | Per-bone allowlist; skeleton-local; needs matching rig in target scene.                                      |
| **Moving lights**                              | swinging lamp, flashlight, patrolling spotlight, sun                    | **Allowed, default OFF**         | Visually meaningful when they move. Replay only matches if the target scene has the same light.              |
| **Non-active cameras**                         | security-monitor feed, scripted cutscene camera                         | **Allowed, default OFF (niche)** | Track its parent transform; rarely worth it.                                                                 |
| **The active / visitor camera**                | the camera the visitor is looking through                               | **Excluded**                     | Already captured as `camera_sample`; re-recording it violates "events live once." Connectors MUST refuse it. |
| **Particle systems**                           | fire, smoke, sparks                                                     | **Out of scope**                 | GPU/simulation-driven, no per-node transform.                                                                |
| **Morph targets / blend shapes**               | facial animation, lip-sync, visemes                                     | **Out of scope**                 | Driven by weight scalars, not a transform.                                                                   |
| **Instanced meshes / thin-instances / crowds** | a crowd of 500 instances under one node                                 | **Out of scope (v1 non-goal)**   | N transforms inside one node; needs an `instanceId` dimension and has extreme volume. A future extension.    |

The active/visitor camera is **rejected with a dev-mode warning** (it is already
`camera_sample`); particle/morph/instance targets are rejected (they cannot
produce a single `node_transform`).

Equivalent older knobs in milliseconds (a `sampling` channel overrides the
matching one):

| Option                  | Default | Effect                                      |
| ----------------------- | ------- | ------------------------------------------- |
| `sampleCameraMs`        | `1000`  | Camera-pose sampling interval.              |
| `samplePerfMs`          | `2000`  | Perf (FPS) sampling interval.               |
| `pointerMoveThrottleMs` | `250`   | Minimum gap between `pointer_move` samples. |

### Idle suppression & dedupe

| Option                    | Default | Effect                                                                                                                                    |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `suppressIdleSamples`     | `true`  | Skip timer-based **camera** samples while the pose is unchanged (the first sample is always emitted).                                     |
| `cameraEpsilon`           | `1e-3`  | Max per-axis pose change treated as "unchanged".                                                                                          |
| `suppressIdlePerfSamples` | `false` | Dedupe `frame_perf` while FPS is steady. Off by default — a stable FPS is meaningful telemetry, so the perf channel reports continuously. |
| `perfFpsThreshold`        | `1`     | Max FPS change treated as "unchanged" (only applies when `suppressIdlePerfSamples` is on).                                                |

The camera channel is deduped by default because a repeated pose carries no new
information; the perf channel is **not**, because a steady frame rate is itself a
useful signal. To capture even more camera detail, set `suppressIdleSamples: false`
and/or raise the sampling rate; to dedupe a stable FPS, set
`suppressIdlePerfSamples: true`.

### Channel toggles (`capture`) and delivery

| Option                                                                                                          | Default      | Effect                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `capture.camera` / `pointerMove` / `clicks` / `buttons` / `meshPicks` / `perf` / `contextLoss` / `compileStall` | all `true`   | Enable/disable individual channels.                                                                                                                                                                                                                                                                                                                          |
| `captureLifecycle`                                                                                              | `true`       | Emit `viewport_resize` / `focus_change` / `visibility_change`.                                                                                                                                                                                                                                                                                               |
| `resizeDebounceMs`                                                                                              | `250`        | Debounce window for `viewport_resize`.                                                                                                                                                                                                                                                                                                                       |
| `captureErrors`                                                                                                 | `false`      | Opt-in `runtime_error` capture (ADR 0013); not auto-redacted.                                                                                                                                                                                                                                                                                                |
| `captureGraphicsDiagnostics`                                                                                    | `false`      | Opt-in engine `graphics_diagnostic` capture (ADR 0021); not auto-redacted. Gates GPU-health signals; `context_lost`/`context_restored` stay always-on.                                                                                                                                                                                                       |
| `captureShaderSource`                                                                                           | `false`      | Sub-opt-in to `captureGraphicsDiagnostics`: include raw shader source in shader-compile diagnostics. Off by default — shader source is application IP (ADR 0021); even with diagnostics on, source is stripped unless this is set. Still length-capped + passes through `beforeSend`.                                                                        |
| `meshVisibility`                                                                                                | _off_        | Opt-in object-dwell capture (`mesh_visibility`, ADR 0003). Pass an options object to enable; off by default for privacy. See below.                                                                                                                                                                                                                          |
| `hoverDwell`                                                                                                    | _off_        | Opt-in hover-hesitation capture (`hover_dwell`, ADR 0003). Enable `capture.hoverDwell` and (optionally) pass an options object; off by default for privacy. See below.                                                                                                                                                                                       |
| `resourceSample`                                                                                                | _off_        | Opt-in GPU/memory footprint capture (`resource_sample`, ADR 0003). Enable `capture.resourceSample` and (optionally) pass a `resourceSample` options object; off by default. See below.                                                                                                                                                                       |
| `gaze`                                                                                                          | _off_        | Opt-in world-space gaze capture (`camera_sample.hitPoint` / `hitMesh`, ADR 0030). Enable `capture.gaze` and (optionally) pass a `gaze` options object; off by default for privacy + cost. See below.                                                                                                                                                         |
| `jankFrameMs`                                                                                                   | `50`         | A rendered frame slower than this counts toward `frame_perf.longFrames`.                                                                                                                                                                                                                                                                                     |
| `flushIntervalMs`                                                                                               | `5000`       | Max time between network flushes. `0` disables the timer.                                                                                                                                                                                                                                                                                                    |
| `transport`                                                                                                     | beacon→fetch | Custom delivery (e.g. to observe sends).                                                                                                                                                                                                                                                                                                                     |
| `offload`                                                                                                       | `main`       | `"worker"` moves per-frame aggregation (percentiles, transform decomposition, visibility bucketing, idle-diffs, gesture classification) + serialization off the render thread into an opt-in same-origin worker; engine reads and the terminal unload flush stay main-thread. Opt-in, byte-for-byte identical output, silent fallback (ADR 0031 / ADR 0044). |
| `disabled`                                                                                                      | `false`      | Collect nothing (e.g. honor Do-Not-Track).                                                                                                                                                                                                                                                                                                                   |
| `debug`                                                                                                         | `false`      | Console debug logs.                                                                                                                                                                                                                                                                                                                                          |
| `sceneDescription`, `user`, `meta`                                                                              | —            | Extra `session_start` context.                                                                                                                                                                                                                                                                                                                               |

### Object dwell (`meshVisibility`) — opt-in

Off by default (ADR 0003). When enabled, the Babylon connector emits one
**bucketed** `mesh_visibility` summary per tracked object per window (ADR 0012) —
never per frame. Each summary carries `visibleMs` (time the object was in view),
`centeredMs` (time it was within `centeredAngleDeg` of the camera forward axis),
and `maxScreenFraction` (its peak apparent size, 0–1).

```ts
trackScene(scene, {
  // ...
  meshVisibility: {
    windowMs: 5000, // one summary per object every 5 s (default)
    meshes: ["product-hero"], // allowlist; omit to track all visible meshes
    maxMeshes: 50, // cap when no allowlist is given (default)
    centeredAngleDeg: 12, // "looking at it" half-angle (default)
    boundingBox: true, // ride each object's world AABB along (off by default)
  },
});
```

With `boundingBox: true`, each summary may also carry `bounds` — the object's
world-space axis-aligned box `[minX, minY, minZ, maxX, maxY, maxZ]` (the
scene-proxy convention). The box is sent **once per object** and re-sent only
when it moves/resizes (bounds are near-static), so the dashboard can render a
coarse "ghost" reconstruction of the scene — one box per observed object — and
lay dwell heat on it without the host's real geometry. Off by default: it adds
volume and discloses scene layout (ADR 0003).

In the dashboard's 3D panels (Flow Sankey, Click rays, World/Gaze heatmap,
View-direction dome), hovering one of these proxy boxes — or a flow mesh
node/ribbon — shows the **mesh name** in a pointer tooltip, so you can identify a
hotspot without guessing; the dome names the look-direction bin instead. The
tooltip clears on pointer-out and never hijacks orbit/zoom. Those panels orbit
the scene center by default; **double-click any point** to re-center the orbit
pivot there (handy in large walkable scenes) and use the on-canvas **recenter**
button to return focus to the default framing.

### Hover hesitation (`hoverDwell`) — opt-in

Off by default (ADR 0003). When `capture.hoverDwell` is enabled, the Babylon
connector watches the object under the pointer and emits one **bucketed**
`hover_dwell` summary per hover _episode_ (ADR 0012) — never per frame. An
episode ends when the pointer moves to a different object (or off all geometry);
its `dwellMs` is reported only if it lasted at least `minDwellMs`. Crucially, an
episode is **suppressed if the object was clicked** during the hover: a click is
an action, not hesitation. High dwell with few interactions is the "this looks
interactive but isn't (or isn't obviously clickable)" signal.

```ts
trackScene(scene, {
  // ...
  capture: { hoverDwell: true },
  hoverDwell: {
    minDwellMs: 500, // ignore pass-overs shorter than this (default)
    meshes: ["product-hero"], // allowlist; omit to track every hovered mesh
  },
});
```

Each `hover_dwell` event carries `mesh`, `dwellMs`, and the originating input
`source` (ADR 0011).

### GPU / memory footprint (`resourceSample`) — opt-in

Off by default (ADR 0003). When `capture.resourceSample` is enabled, the connector
samples the _actual cost the scene asks of the device_ on a slow timer (default
every 15 s — ADR 0012), separate from per-frame `frame_perf`. Each
`resource_sample` carries whatever the engine can cheaply report, all optional:
`textureBytes`, `geometryBytes` (resident GPU memory), `triangles`, `vertices`
(submitted last frame), and `jsHeapBytes` (JS heap). Pair it with the device caps
on `session_start` to spot scenes that overspend their target hardware.

```ts
trackScene(scene, {
  // ...
  capture: { resourceSample: true },
  resourceSample: {
    intervalMs: 15000, // one footprint sample per window (default)
  },
});
```

Connector coverage differs by what each engine exposes structurally (the SDK never
mutates the engine): the **Babylon** connector reports `triangles` (active
indices ÷ 3) and `vertices`; the **three.js** connector reports `triangles`
(`renderer.info.render.triangles`). `jsHeapBytes` comes from
`performance.memory.usedJSHeapSize`, which is **Chromium-only** — it's omitted on
other browsers rather than zeroed. Resident `textureBytes`/`geometryBytes` aren't
on either engine's public surface, so they're left unset; the read API's averages
ignore unreported metrics (so an absent metric never reads as `0`).

### World-space gaze (`gaze`) — opt-in

Off by default (ADR 0030, privacy + cost). When `capture.gaze` is enabled, the
connector raycasts the **camera-forward ray into the scene** on each frame that
already emits a `camera_sample`, and attaches the surface hit to that sample as
`hitPoint` (world-space point) + `hitMesh` (the hit object's name) — exactly the
columns the world heatmap already reads, so **no migration** is needed. This
answers "where did the audience's _gaze_ rest on the actual geometry" for every
camera style (orbit, first-person, XR), distinct from the click-only world
heatmap and the abstract view-direction sphere.

Gaze is **cheap by design**: one pick per _emitted_ pose. It rides the existing,
idle-suppressed camera cadence (`sampleCameraMs`, default 1 s) — it never adds a
timer or picks at frame rate, and a pose-deduped (static) frame costs nothing.

```ts
trackScene(scene, {
  // ...
  capture: { gaze: true },
  gaze: {
    maxDistance: 1000, // ignore hits farther than this along the ray (default)
    meshes: ["product-hero"], // allowlist; omit to hit any mesh
    predicate: (mesh) => mesh.name !== "ground", // exclude skybox/helpers (sync connectors)
  },
});
```

The hit is normalized to the canonical coordinate frame at the emission boundary
(ADR 0018), so the `gaze` heatmap aligns with the pointer world heatmap across
engines. Connector parity (same `capture.gaze` flag + `GazeOptions`):

- **`@uptimizr/babylon`** — `scene.pickWithRay()` from `camera.getForwardRay()` (sync); `predicate` supported.
- **`@uptimizr/three`** — single reused `THREE.Raycaster` from NDC centre (sync); `predicate` over `Object3D`.
- **`@uptimizr/playcanvas`** — single reused `pc.Ray` vs mesh-instance AABBs (sync, physics-free); `predicate` over `GraphNode`.
- **`@uptimizr/babylon-lite`** — async GPU picker at the centre pixel; the hit rides the **next** sample (≤ 1 sample latency) and there is **no `predicate`** (name allowlist + `maxDistance` only).
- **`@uptimizr/r3f`** — inherits three's options verbatim; pass `capture.gaze` + `gaze` through `useUptimizr` / `<Uptimizr>`.
- **`@uptimizr/aframe`** — flat HTML schema exposes a boolean toggle only: `<a-scene uptimizr="gaze: true">` (three's `GazeOptions` defaults apply; no allowlist/predicate).

Head-forward gaze is a **proxy**, not eye-tracked gaze: a centered model can
over-attribute gaze to whatever sits at screen center. Read the result via
`GET /api/v1/heatmaps/gaze` (below); it reuses the world heatmap's voxel grid,
params, and 3D renderer.

### Frame performance (`frame_perf`) fields

Beyond `fps`/`frameTimeMs`/`drawCalls`, each `frame_perf` sample reports
percentiles and render resolution measured over the sampling window:

| Field                              | Meaning                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `frameTimeP95Ms`, `frameTimeP99Ms` | 95th/99th-percentile frame time over the window (jank tail).      |
| `longFrames`                       | Count of frames slower than `jankFrameMs` in the window.          |
| `dpr`                              | Device pixel ratio.                                               |
| `renderScale`                      | Engine hardware-scaling factor (`1` = native, `<1` = downscaled). |

`asset_load` likewise carries an optional `ttiMs` (time-to-interactive for the
asset) alongside `loadMs`/`ttffMs`. The **PlayCanvas** connector emits `asset_load`
automatically by hooking the `app.assets` registry load lifecycle (name + `loadMs`,
and `bytes` when known; on by default, disable via `capture.assetLoad`). Other
connectors leave `asset_load` to the host app — emit it on the `UptimizrClient`
when your loader finishes. See
[Connectors → asset-load capture](/docs/connectors/overview/#asset-load-capture-asset_load)
for the per-engine parity table.

### Pointer lock (first-person / FPS scenes)

First-person / walkable scenes (ADR 0026) navigate with the browser **Pointer
Lock API** — `PointerLockControls` (three), `Mouse.enablePointerLock()`
(PlayCanvas), or `engine.enterPointerlock()` (Babylon). While locked the OS cursor
is hidden and its absolute position freezes, so the aim point is the fixed
**crosshair at the viewport centre**, not a cursor.

The connectors handle this automatically (ADR 0034): when the rendering canvas
holds the pointer lock, `pointer_move` / `pointer_down` / `pointer_up` /
`pointer_click` report `screen = [0.5, 0.5]` and pick from NDC `(0, 0)`, so
`hitMesh` / `hitPoint` describe what the visitor actually aimed at. No
configuration is required, and nothing changes for cursor (orbit/viewer) scenes.

Consequently the **2D pointer/click heatmap degenerates to a centre cluster**
while locked (that is the truthful signal — "FPS aiming"). The meaningful spatial
reads for a locked first-person scene are the cursor-independent ones: the
**world-space gaze heatmap** (above), the **floor-plan position heatmap**, and the
**session trajectory** (ADR 0026).

---

## 3. Replay

Replay re-drives a captured session in **your own** scene: camera pose is applied
directly, and pointer/mesh/custom events are surfaced to callbacks so you can draw
a cursor, highlight a mesh, etc. The collector must have raw-session retention
enabled for the session-events endpoint to return data.

### Option A — npm

```bash
npm install @uptimizr/replay
```

```ts
import { fetchSessionEvents, ReplayPlayer } from "@uptimizr/replay";
import { createBabylonReplayDriver } from "@uptimizr/replay/babylon";

const events = await fetchSessionEvents({ endpoint, apiKey, sessionId });
const driver = createBabylonReplayDriver({
  scene,
  onPointer: (screen, hitPoint, hitMesh, type) => {
    /* draw cursor / flash */
  },
  onMeshInteraction: (mesh, kind) => {
    /* highlight */
  },
  onCustom: (name, props) => {
    /* timeline marker */
  },
  onInputAction: (input, ts) => {
    /* annotate a keyboard/gamepad action: input.action / input.source /
       input.code / input.button / input.pressed (ADR 0023) */
  },
  onLifecycle: (event, ts) => {
    /* annotate the timeline: viewport_resize / focus_change /
       visibility_change / context_lost / context_restored */
  },
  onError: (error, ts) => {
    /* mark where a runtime_error interrupted the session
       (only present if captureErrors was enabled) */
  },
});
const player = new ReplayPlayer(events, driver, { speed: 1 });
player.play();
// player.pause(); player.seek(ms); player.stop();
```

To replay **scene actors** (`node_transform`, ADR 0027), pass a `nodes` map from
each recorded `nodeId` to the engine node to drive, and/or an `onNodeTransform`
callback to observe every sample. The Babylon, three, and PlayCanvas drivers
re-apply Tier-1 root transforms **and** Tier-2 skeleton bones (finding each bone
by name on the node's skeleton — three's `SkinnedMesh.skeleton.bones`, PlayCanvas'
`skinInstance.bones`). The `babylon-lite` driver drives the Tier-1 root and
forwards bone samples to the callback only (no named-bone API):

```ts
const driver = createBabylonReplayDriver({
  scene,
  nodes: {
    "npc-guard": () => scene.getMeshByName("Guard_root"), // resolver, name, or ref
  },
  onNodeTransform: (sample, ts) => {
    /* sample.nodeId / sample.boneId? / sample.position / sample.rotation /
       sample.scale? — annotate or drive a proxy marker */
  },
});
```

Unknown `nodeId`/`boneId` are skipped without error (forward/back-compatible).

For **three.js**, import the three driver from `@uptimizr/replay/three` instead.
three has no `scene.activeCamera`, so the `camera` is a required option:

```ts
import { createThreeReplayDriver } from "@uptimizr/replay/three";

const driver = createThreeReplayDriver({
  scene,
  camera, // required
  onPointer: (screen, hitPoint, hitMesh, type) => {
    /* draw cursor / flash */
  },
});
```

The same `fetchSessionEvents` + `ReplayPlayer` drive it; only the driver differs.

`ReplayPlayer` is deterministic — seeking backward resets the driver and replays
from the start. `player.durationMs` gives the total length.

#### Rigid subtree reconstruction (`reconstructRigidSubtree`, ADR 0033)

The capture side samples one moving node's world transform per frame
(`node_transform`). To re-pose an entire **rigid** sub-hierarchy from that single
sample, `@uptimizr/replay` exposes a pure, engine-agnostic helper that combines the
sampled root pose with the scene proxy's scan-time `path`/`world` fields:

$$\text{childWorld}(t) = \text{rootWorld}(t)\;\cdot\;\text{rootWorld}(t_0)^{-1}\;\cdot\;\text{childWorldAtScan}$$

```ts
import { reconstructRigidSubtree } from "@uptimizr/replay";

const meshes = reconstructRigidSubtree({
  proxy, // the registered SceneProxy (carries per-mesh path + scan-time world)
  rootPath: "Forklift/Mast", // the captured node's path
  rootWorld: sampledRootTransform, // its live { position, rotation, scale } at time t
  // rootWorldAtScan is optional; falls back to the proxy mesh whose path === rootPath
});
// → [{ name, path, world: { position, rotation, scale } }, …] for strict descendants
```

It returns only **strict descendants** of `rootPath` (the mesh at `rootPath`
itself is driven directly by the sample). It is rigid-only: non-rigid deformation
isn't reconstructed, and a directly captured `childPath` sample always wins over a
reconstructed pose. If no scan-time root transform is available (or the root matrix
is singular) it returns `[]`.

#### Loading a scene backdrop (`loadSceneBackdrop`)

Replay normally re-drives into the scene you already have. When you only have the
captured stream and no scene to host it — a hosted drag-and-drop viewer, for
example — load an arbitrary asset as a **backdrop** first, then replay over it. The
Babylon helper accepts a URL **or** a dropped `File`:

```ts
import { loadSceneBackdrop } from "@uptimizr/replay/babylon";

const backdrop = await loadSceneBackdrop(scene, urlOrFile); // ".glb" / ".gltf"
console.log(`${backdrop.meshes.length} meshes added`);

backdrop.dispose(); // remove it (e.g. to swap one dropped model for the next)
```

`loadSceneBackdrop(scene, source, options?)` returns a handle
(`{ rootNodes, meshes, container, dispose() }`). Its `dispose()` removes everything
it added and releases the GPU resources. The default loader **lazily** imports
Babylon's glTF `SceneLoader`, so the lean replay path never pulls it in unless a
backdrop is requested; pass `options.load` for a custom loader or
`options.pluginExtension` to force a parser. Actor/subtree nodes from the loaded
model re-drive exactly like any other scene node (`node_transform`, ADR 0033).

The dashboard's **Session replay** birdview exposes this with no code: a **Load
model (.glb)** control under the timeline loads a `.glb`/`.gltf` and replaces the
wireframe proxy boxes with the real model, re-driving the session over it (**Replace
model** swaps files, **Remove model** restores the boxes). The model stays in the
browser for that view — nothing is uploaded.

The global build exposes `window.UptimizrReplay`, with a one-call
`replayInScene` convenience that fetches and plays a session:

```js
const r = document.createElement("script");
r.src = "https://collect.example.com/uptimizr-replay.global.js";
r.onload = () => {
  UptimizrReplay.replayInScene({
    scene,
    endpoint: "https://collect.example.com",
    apiKey: "your-project-api-key",
    sessionId: "<copy from the dashboard Sessions table>",
    backdropUrl: "https://example.com/room.glb", // optional — load a model first
    debug: true, // log fetch/play progress to the console
  });
};
document.head.appendChild(r);
```

`pnpm playground` prints this snippet pre-filled and serves the bundle at
`/uptimizr-replay.global.js`.

`backdropUrl` loads a `.glb`/`.gltf` into the scene before replay. To keep the
global bundle from shipping a second copy of Babylon's `SceneLoader`, it **reuses
the host page's loader**: expose Babylon as `window.BABYLON` (with
`LoadAssetContainerAsync` and a glTF loader registered) or pass an explicit
`loadBackdrop` callback. When no loader is found it warns and replays without a
backdrop.

`replayInScene` starts playback immediately; it does not wait for the scene to be
"ready", so call it once `scene` exists and has an `activeCamera`. It always logs
a concise summary and warns about the common "nothing happens" causes — an empty
session, a session with no `camera_sample` events (camera won't move), or a scene
with no active camera. Pass `debug: true` for per-step logs (fetch, event counts,
duration, completion). A `403` from the events endpoint means raw-session
retention is off (`ENABLE_RAW_SESSION_RETENTION`, ADR 0003).

If a session returns **0 events** (a `200` with an empty array), the most common
cause is an **API-key / project mismatch**: reads are scoped to the key's project,
so a valid session id looked up with another project's key returns nothing. Copy
the session id and the API key from the **same** dashboard project.

### In-scene heatmap & gaze overlays (`@uptimizr/heatmap`)

Beyond the dashboard viewers, you can paint analytics **into your own running
scene** (the Tier 0 "dev-integrated overlay", ADR 0010) with `@uptimizr/heatmap`.
The core is engine-agnostic; the Babylon adapter draws everything as a single
thin-instanced mesh.

```ts
import { showWorldHeatmap, showGazeDome, showGazeSkydome } from "@uptimizr/heatmap/babylon";

// World-space pointer heatmap (GET /api/v1/heatmaps/world) as voxel blocks.
const world = await showWorldHeatmap({
  scene,
  endpoint: "https://collect.example.com",
  apiKey: "your-project-api-key",
  cellSize: 0.5, // must match how the grid is binned
  style: { opacity: 0.85, maxVoxels: 2000 },
});

// Gaze dome (GET /api/v1/heatmaps/camera): view-direction distribution as
// markers on a sphere, optionally centered on the live camera.
const gaze = await showGazeDome({
  scene,
  endpoint: "https://collect.example.com",
  apiKey: "your-project-api-key",
  bins: 36, // grid resolution per axis
  followCamera: scene.activeCamera ?? undefined,
  style: { radius: 8, opacity: 0.9 }, // radius is in the host scene's units
});

// Gaze skydome (same camera query): the continuous form — bins are splatted into
// an equirectangular heat texture on an inward dome you stand inside (great in XR).
const sky = await showGazeSkydome({
  scene,
  endpoint: "https://collect.example.com",
  apiKey: "your-project-api-key",
  bins: 36,
  followCamera: scene.activeCamera ?? undefined,
  radius: 50,
  texture: { width: 256, blurBins: 1.5, opacity: 0.95 },
});

world.setVisible(false); // toggle any overlay
gaze.dispose(); // remove from the scene when done
sky.dispose();
```

All helpers return an overlay handle (`render` / `setVisible` / `dispose`). There
is no scene registry at this tier, so `cellSize` and the gaze `radius` have no
inherent units — supply values that fit your scene (or expose them as controls).
Gaze has two in-scene forms — `showGazeDome` (discrete markers) and
`showGazeSkydome` (continuous equirectangular field, with the engine-free
`buildGazeEquirect` builder exported for non-Babylon hosts).
For a no-bundler page, the package also ships an ESM build
(`dist/uptimizr-heatmap.babylon.js`) you can import from a
`<script type="module">` (it expects the host page to provide `@babylonjs/core`).

---

## 4. HTTP API

The collector exposes one ingestion endpoint and a set of read endpoints. Reads
are authenticated with a project API key (`x-api-key`); the project is resolved
from the key, so a client can only ever read its own data.

### Ingestion

| Method | Path              | Notes                                                                                                          |
| ------ | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/v1/collect` | Batched events. The SDK uses `navigator.sendBeacon` (credentialed) and falls back to `fetch` with `keepalive`. |

### Query (read)

> Querying this API as a contributor or agent? See the
> [`query-analytics`](../.github/skills/query-analytics/SKILL.md) skill for the workflow, unit
> pitfalls, and the read-only [`@uptimizr/mcp`](../oss/packages/mcp/README.md) server.

All query endpoints take `x-api-key` and the shared params `since`, `until`
(epoch ms), and (where binned) `bins`. The aggregate endpoints also accept an
optional `session` to scope results to a single session id. The heatmap endpoints
accept an optional `scene` to scope results to one scene/area/level id (the value
passed to `setScene` / `meta.sceneId`); the pointer heatmap additionally accepts
`source` (input source, e.g. an XR controller, ADR 0011). Several endpoints accept
an optional `cameraMode` (`viewer` | `first-person`, ADR 0026) that restricts the
aggregate to sessions whose camera was an orbit/arc-rotate (`viewer`) or a
free/walkable (`first-person`) camera.

The world and gaze heatmaps additionally support **large-scene resolution** (ADR
0040): omit `cellSize` and the collector derives it from the selected scene's
registered world bounds (or, when a `region` is given, from that box) so big
scenes stay legible instead of collapsing into a few coarse voxels; pass an
explicit `cellSize` to override. A `region=minX,minY,minZ,maxX,maxY,maxZ` filter
restricts a world/gaze/position heatmap to an axis-aligned box for drill-down,
and the companion `/stats` endpoints report the **true** occupied-cell and hit
totals behind the truncated top-N voxel list (so cold spots and coverage read
correctly). The dashboard's 3D world heatmap also normalizes color/size to the
95th-percentile cell, so a few hotspots no longer wash out the rest of the scene.

| Method | Path                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                             | Extra params                                                                                  |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/sessions`                | Recent sessions (id, visitor, event count, start/end).                                                                                                                                                                                                                                                                                                                                                                              | `limit`, `cameraMode`                                                                         |
| `GET`  | `/api/v1/heatmaps/pointer`        | 2D pointer heatmap bins.                                                                                                                                                                                                                                                                                                                                                                                                            | `bins`, `scene`, `source`, `session`, `cameraMode`                                            |
| `GET`  | `/api/v1/heatmaps/world`          | 3D world-space pointer heatmap (ADR 0010). `cellSize` defaults to the scene/region bounds when omitted (ADR 0040).                                                                                                                                                                                                                                                                                                                  | `cellSize`, `region`, `scene`, `source`, `cameraMode`                                         |
| `GET`  | `/api/v1/heatmaps/world/stats`    | World-heatmap totals (ADR 0040 §3): `{ cellSize, cells, hits }` — the true occupied-cell + hit counts behind the truncated `/heatmaps/world` voxels, with the effective `cellSize`. No `limit`.                                                                                                                                                                                                                                     | `cellSize`, `region`, `scene`, `source`, `cameraMode`                                         |
| `GET`  | `/api/v1/heatmaps/gaze`           | 3D world-space **gaze** heatmap (ADR 0030): voxel-binned `camera_sample.hit_point` — where the audience _looked_ on the geometry. Same grid/row shape as `/heatmaps/world`; requires `capture.gaze`.                                                                                                                                                                                                                                | `cellSize`, `region`, `scene`, `session`, `cameraMode`                                        |
| `GET`  | `/api/v1/heatmaps/gaze/stats`     | Gaze-heatmap totals (ADR 0040 §3): `{ cellSize, cells, hits }` — the gaze sibling of `/heatmaps/world/stats`.                                                                                                                                                                                                                                                                                                                       | `cellSize`, `region`, `scene`, `session`, `cameraMode`                                        |
| `GET`  | `/api/v1/heatmaps/camera`         | View-direction heatmap (spherical bins).                                                                                                                                                                                                                                                                                                                                                                                            | `bins`, `scene`, `session`, `cameraMode`                                                      |
| `GET`  | `/api/v1/heatmaps/position`       | Top-down floor-plan camera-position heatmap (ADR 0026): `camera_sample` positions binned on the X/Z ground plane (`gx,gz,avg_y,count`). First-person analog of the pointer heatmap.                                                                                                                                                                                                                                                 | `cellSize`, `region`, `scene`, `session`, `cameraMode`                                        |
| `GET`  | `/api/v1/heatmaps/click-rays`     | Click rays: pose sources (XR/hand/gaze) use their own ray origin; flat pointers (mouse/touch/stylus) reconstruct the ray origin by unprojecting the click's `screen` onto the camera's near plane (using the `camera_sample` `fov`/`aspect`/`near` intrinsics), falling back to the nearest camera-sample position when those intrinsics are absent or the view basis is degenerate. Per voxel/mesh.                                | `cellSize`, `scene`, `source`, `session`                                                      |
| `GET`  | `/api/v1/heatmaps/flow`           | Aggregate gaze→mesh flow links: direction-bin to clicked-mesh counts (no timeline required). Position-aware mode (§7.8) restores the click-time camera **standpoint**: pass `groupByOrigin=true` to also bin by standpoint voxel, or `originVoxel=vx,vy,vz` to scope to one standpoint — rows then carry `origin_vx/vy/vz` and averaged `origin_x/y/z`. Most useful for first-person/walkable scenes (pair with `cameraMode`).      | `bins`, `limit`, `scene`, `session`, `cellSize`, `groupByOrigin`, `originVoxel`, `cameraMode` |
| `GET`  | `/api/v1/meshes/top`              | Most-interacted meshes.                                                                                                                                                                                                                                                                                                                                                                                                             | `limit`, `session`                                                                            |
| `GET`  | `/api/v1/meshes/sources`          | Part-popularity source split (#74): per `(mesh, source)` `count` — which input source (mouse/touch/XR/…) drove each mesh's interactions. Scoped to **active interactions** (`mesh_interaction` + `pointer_click`), so passive gaze hits are excluded — this diverges from `/meshes/top`, which counts every mesh-referencing event. The leaderboard reads both rank (sum across sources) and the per-row split from this one query. | `limit`, `scene`, `source`, `session`                                                         |
| `GET`  | `/api/v1/meshes/trend`            | Part-popularity trend (#74): per `(mesh, bucket)` `count` bucketed into fixed `interval`-second windows — powers each leaderboard row's sparkline and rising/falling delta. Same active-interaction scope as `/meshes/sources` (gaze excluded).                                                                                                                                                                                     | `interval` (sec, default 3600), `limit`, `scene`, `source`, `session`                         |
| `GET`  | `/api/v1/meshes/dwell`            | Object dwell ranking from `mesh_visibility`: per-mesh `visible_ms`, `centered_ms`, `max_screen_fraction`, `samples`.                                                                                                                                                                                                                                                                                                                | `scene`, `session`                                                                            |
| `GET`  | `/api/v1/meshes/kinds`            | Interaction-kind breakdown from `mesh_interaction`: per `(mesh, kind)` `count` — which meshes are clicked vs. hovered vs. dragged (#72).                                                                                                                                                                                                                                                                                            | `limit`, `scene`, `source`, `session`                                                         |
| `GET`  | `/api/v1/clicks/dead`             | Dead-click rate from `pointer_click`: `total_clicks` and `dead_clicks` (clicks that hit empty space). Derive the rate as `dead_clicks / total_clicks`.                                                                                                                                                                                                                                                                              | `scene`, `source`, `session`                                                                  |
| `GET`  | `/api/v1/clicks/rage`             | Rage-click clusters from `pointer_click`: `(session_id, mesh, bucket, clicks)` where `clicks >= minRepeats` rapid repeats hit the same mesh in one window.                                                                                                                                                                                                                                                                          | `interval` (sec, default 2), `minRepeats` (default 3), `limit`, `scene`, `source`, `session`  |
| `GET`  | `/api/v1/hover/dwell`             | Hover-hesitation ranking from `hover_dwell`: per-mesh `dwell_ms`, `max_dwell_ms`, `episodes` (hovers that didn't lead to a click).                                                                                                                                                                                                                                                                                                  | `limit`, `scene`, `source`, `session`                                                         |
| `GET`  | `/api/v1/perf/compile-stalls`     | Shader/pipeline compile stalls from `compile_stall`: per-`phase` `stalls`, `total_ms`, `avg_ms`, `max_ms` (the felt first-interaction jank `frame_perf` averages away).                                                                                                                                                                                                                                                             | `limit`, `scene`, `session`                                                                   |
| `GET`  | `/api/v1/perf`                    | Rendering-performance summary (samples, avg/min/p50 FPS).                                                                                                                                                                                                                                                                                                                                                                           | `session`                                                                                     |
| `GET`  | `/api/v1/perf/render-scale`       | Render-scale truth from `frame_perf`: `samples`, avg/p50 `fps`, avg/p50 `render_scale`, `downscaled_samples`, `scale_samples` — reveals FPS bought by dynamic downscaling rather than real headroom (#71).                                                                                                                                                                                                                          | `session`                                                                                     |
| `GET`  | `/api/v1/perf/resources`          | GPU/memory footprint summary from `resource_sample`: `samples` plus avg/max `js_heap_bytes`, `triangles`, `vertices`, `texture_bytes`, `geometry_bytes` (averages skip unreported metrics).                                                                                                                                                                                                                                         | `session`                                                                                     |
| `GET`  | `/api/v1/capabilities`            | Capability fallbacks/recoveries from `capability_change`: per `(kind, from, to)` `changes` count (e.g. how many sessions fell back WebGPU→WebGL2).                                                                                                                                                                                                                                                                                  | `limit`, `scene`, `session`                                                                   |
| `GET`  | `/api/v1/graphics-diagnostics`    | Opt-in GPU-health rollup from `graphics_diagnostic`: per `(severity, category, backend)` `incidents` count. Folds discrete markers (no `count`) and per-session rollups (`count: N`) honestly as `SUM(COALESCE(count, 1))` (ADR 0021). Capture is **off by default**, so this is empty unless `captureGraphicsDiagnostics` is enabled. Powers the dashboard "Engine diagnostics" panel.                                             | `scene`, `session`                                                                            |
| `GET`  | `/api/v1/rendering-technology`    | Always-on rendering-technology mix from `session_start.graphics`: per `(api, backend, api_version, shading_language)` `sessions` count. Captured once per session and always on (ADR 0021 / ADR 0046), so a populated result is the common case; blank fields surface as "unknown". Powers the dashboard "Rendering technology" panel.                                                                                              | `scene`, `session`                                                                            |
| `GET`  | `/api/v1/camera-gestures`         | Camera-navigation breakdown from `camera_gesture`: per-`kind` (orbit/pan/dolly/zoom/roll/fly) `gestures`, `total_ms`, `avg_ms`, `max_ms` (deliberate viewpoint movement, separated from object selection).                                                                                                                                                                                                                          | `limit`, `scene`, `source`, `session`                                                         |
| `GET`  | `/api/v1/coverage`                | Scene coverage / dead zones: occupied camera-position voxels (`vx,vy,vz,count`) from `camera_sample`.                                                                                                                                                                                                                                                                                                                               | `cellSize`, `scene`, `source`, `session`                                                      |
| `GET`  | `/api/v1/camera/distance`         | Camera distance / zoom: histogram of camera-to-center distance (`bucket`, `count`).                                                                                                                                                                                                                                                                                                                                                 | `centerX/Y/Z`, `bucketSize`, `scene`, `source`, `session`                                     |
| `GET`  | `/api/v1/navigation`              | Navigation effort / friction: per-session travel (`segments`, `total_distance`, active vs idle).                                                                                                                                                                                                                                                                                                                                    | `moveThreshold`, `scene`, `source`, `session`                                                 |
| `GET`  | `/api/v1/xr/rotation`             | XR motion-sickness proxy: per-session head/view rotation rate over `camera_sample` (`samples`, `avg_turn_rad`, `max_turn_rad`, `total_turn_rad`, `rapid_segments`).                                                                                                                                                                                                                                                                 | `rapidTurn` (rad, default 0.5), `limit`, `scene`, `session`                                   |
| `GET`  | `/api/v1/xr/sources`              | XR input-source usage: hand vs. controller (vs. gaze) split from `source` (`source`, `interactions`, `sessions`).                                                                                                                                                                                                                                                                                                                   | `limit`, `scene`, `session`                                                                   |
| `GET`  | `/api/v1/interactions/sources`    | Input-source breakdown (ADR 0011): per `(event_type, source)` `count` + `sessions` across all input-bearing interactions (mouse/touch/XR controller/hand/gaze/keyboard/gamepad/…).                                                                                                                                                                                                                                                  | `limit`, `scene`, `source`, `session`                                                         |
| `GET`  | `/api/v1/input-actions/top`       | Most-used shortcuts (#75, ADR 0023): per `(action, source)` `count` from `input_action` events — the app-level actions/shortcuts visitors trigger most, split by input source.                                                                                                                                                                                                                                                      | `limit`, `scene`, `source`, `session`                                                         |
| `GET`  | `/api/v1/xr/abandonment`          | XR session abandonment: per XR session `events`, `xr_interactions`, `started_at`, `ended_at` (short span ⇒ headset drop-off).                                                                                                                                                                                                                                                                                                       | `limit`, `scene`, `session`                                                                   |
| `GET`  | `/api/v1/scenes`                  | Distinct scenes with activity (id, event count, last seen) for the scene picker (ADR 0010).                                                                                                                                                                                                                                                                                                                                         | `limit`                                                                                       |
| `GET`  | `/api/v1/timeseries`              | Event-volume buckets over time (`bucket` epoch-ms, `events`, `avg_fps`) — the time dimension.                                                                                                                                                                                                                                                                                                                                       | `scene`, `interval` (sec), `type`                                                             |
| `GET`  | `/api/v1/event-counts`            | Per-event-type counts over the range (powers the scene-health panel).                                                                                                                                                                                                                                                                                                                                                               | `scene`                                                                                       |
| `GET`  | `/api/v1/funnel`                  | Ordered, per-session conversion funnel (ADR 0038, #78): how many sessions reach each step of a caller-supplied sequence (`step`, `sessions`). Steps come in via the `steps` query param — there is no authoring surface in OSS.                                                                                                                                                                                                     | `steps` (JSON, required), `scene`, `cameraMode`                                               |
| `GET`  | `/api/v1/sessions/:id/meta`       | Coarse session descriptor (device/scene/user).                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                             |
| `GET`  | `/api/v1/sessions/:id/trajectory` | One session's ordered walked path (ADR 0026): `camera_sample` positions oldest-first (`ts,x,y,z`).                                                                                                                                                                                                                                                                                                                                  | `scene`, `limit`                                                                              |
| `GET`  | `/api/v1/paths`                   | Aggregate desire lines (ADR 0037): every session's `camera_sample` path binned onto the X/Z ground grid (`session_id,ts,gx,gz`), ordered per session — the crowd's common routes overlaid as low-opacity poly-lines (#73).                                                                                                                                                                                                          | `cellSize`, `limit`, `scene`, `cameraMode`                                                    |
| `GET`  | `/api/v1/sessions/:id/events`     | Ordered raw event stream for replay. Requires `ENABLE_RAW_SESSION_RETENTION` (ADR 0003); otherwise `403`.                                                                                                                                                                                                                                                                                                                           | —                                                                                             |

### Scene registry (representations)

A scene can register a **proxy** of its geometry (per-mesh AABBs, ADR 0014) so the
dashboard's 3D heatmap draws hotspots against a recognizable backdrop. The proxy is
produced client-side by `scanSceneProxy(scene, { sceneId })` (`@uptimizr/babylon`,
`@uptimizr/three`, `@uptimizr/playcanvas`) and `PUT` under the matching `sceneId`.
Writes use the same project API key as reads.

Each proxy mesh may also carry two optional fields used for **rigid subtree
reconstruction** (ADR 0033). When a mesh has a fully-named ancestor chain,
`scanSceneProxy` records its `path` (slash-joined node names, e.g.
`"Forklift/Mast/Fork"`) and its scan-time world transform `world`
(`{ position, rotation, scale }`, canonical left-handed frame). These let replay
re-pose a whole sub-hierarchy from a single captured node's `node_transform`
stream (see `reconstructRigidSubtree` below). Both fields are emitted together or
not at all; meshes without a named hierarchy or a readable world matrix omit them,
and the proxy content hash is unchanged when they are absent.

| Method | Path                                     | Purpose                                                                             | Body / params       |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| `PUT`  | `/api/v1/scenes/:sceneId/representation` | Register/replace a scene proxy. The body's `proxy.sceneId` must match the path id.  | `{ proxy, label? }` |
| `GET`  | `/api/v1/scenes/:sceneId/representation` | Fetch a scene's stored representation (proxy + bounds). `404` if never registered.  | —                   |
| `GET`  | `/api/v1/scene-representations`          | List registered scenes (summary: id, label, kind, bounds, hash) — omits proxy blob. | —                   |

Example:

```bash
curl -X PUT -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"proxy": <SceneProxy>, "label": "Main Lobby"}' \
  "https://collect.example.com/api/v1/scenes/lobby/representation"
```

```bash
curl -H "x-api-key: $KEY" \
  "https://collect.example.com/api/v1/perf?session=<session-id>"
```

> Aggregate columns (`count()`, percentiles, sums) come back as JSON numbers from
> every store, including ClickHouse — the `clickhouse` store disables 64-bit
> integer quoting so results match the DuckDB store byte-for-byte. The dashboard's
> `CollectorApi` still coerces defensively.

### Funnels (`/api/v1/funnel`) — caller-configured (ADR 0038, #78)

A **funnel** counts how many sessions reach each step of an ordered sequence of
events — e.g. _opened the scene → orbited the camera → clicked the product_. The
collector computes the aggregation; it does **not** author or store funnel
definitions. The OSS dashboard is a passive viewer with no configuration surface
(ADR 0038), so the **caller supplies the steps on every request** (CLI, a seed
script, or the hosted product). Step authoring, persistence, and the saved-funnel
panel live in the hosted product.

`steps` is a URL-encoded JSON array of **2–20** step predicates over the wide event
table:

| Field   | Required | Matches                                                             |
| ------- | -------- | ------------------------------------------------------------------- |
| `type`  | yes      | the event type (e.g. `camera_sample`, `mesh_interaction`, `custom`) |
| `name`  | no       | a gesture/interaction kind or custom-event name                     |
| `mesh`  | no       | a single object name                                                |
| `label` | no       | presentation-only; ignored by the query                             |

**Semantics** — sequential, first-touch, monotonic: step 0 is a session's first
matching event; a session reaches step _N_ iff it has an event matching step _N_'s
predicate at a timestamp **at or after** the first time it reached step _N−1_.
Out-of-order events therefore don't count, and a step can never report more
sessions than the step before it.

```bash
STEPS='[{"type":"camera_sample"},{"type":"mesh_interaction","name":"pick","mesh":"product"}]'
curl -H "x-api-key: $KEY" \
  --get "https://collect.example.com/api/v1/funnel" \
  --data-urlencode "steps=$STEPS" --data-urlencode "scene=lobby"
# → [{ "step": 0, "sessions": 128 }, { "step": 1, "sessions": 37 }]
```

From the client:

```ts
const rows = await api.funnel(
  [{ type: "camera_sample" }, { type: "mesh_interaction", name: "pick", mesh: "product" }],
  { scene: "lobby" },
);
```

---

## 5. Extending the dashboard (custom panels)

The dashboard is assembled from **panels** — each built-in panel (pointer heatmap,
top meshes, the 3D view-direction dome, …) is a plain `PanelDefinition` object from
[`@uptimizr/react`](../oss/packages/react/README.md), and you register your own the
same way (ADR 0036).

A panel declares what data it needs and how to render its body; the dashboard host
supplies the chrome, the grid slot, the query client, the active filters, and the
live layer through a single `PanelContext`. The contract is powerful enough to
express every built-in panel — a list, a 2D canvas heatmap, or a client-only
Babylon 3D scene.

```ts
import { definePanel } from "@uptimizr/react";

export const myPanel = definePanel<MyData>({
  id: "my-panel",
  title: "My panel",
  subtitle: "What it shows", // string, or (ctx) => string
  span: 1, // 1 = half width, 2 = full width
  surfaces: ["overview", "session"], // default ["overview"]
  clientOnly: false, // true to skip SSR (canvas / Babylon)
  enabled: (ctx) => ctx.capabilities.hasFirstPerson, // optional gate
  load: (ctx) => ctx.api.topMeshes({ ...ctx.params, limit: 25 }),
  render: ({ data, ctx }) => <MyView rows={data} ctx={ctx} />,
});
```

`load(ctx)` runs whenever the filters, surface, or inspected session change; the host
cancels superseded requests via `ctx.signal` and tracks `loading` / `error`. Omit
`load` for panels that self-fetch inside `render`. `render` returns the panel **body
only** — the host wraps it in the card and grid cell.

The `PanelContext` carries everything a panel needs: `api` (a shared `CollectorApi`),
`baseUrl` / `apiKey`, the resolved `params`, raw `filters`, `surface` / `sessionId`,
range-derived `capabilities`, host `actions` (`selectSession`, `setTimeRange`,
`setFilters`), the realtime `live` layer (`presence`, `enabled`, `subscribe(handler)`),
and the resolved per-panel `settings` (see below).

### Per-panel settings & visibility (ADR 0039)

A panel can declare typed `settings` that a viewer tunes at runtime from the panel's
"⚙" menu — a clamped `number` (slider), a `boolean` (toggle), or a `select` (enum):

```ts
export const floorPlanPanel = definePanel({
  id: "floor-plan",
  title: "Floor-plan heatmap",
  settings: {
    cellSize: { type: "number", label: "Cell size", default: 1, min: 0.25, max: 5, step: 0.25, unit: "m" },
  },
  // ctx.settings.cellSize is typed `number`, defaulted + clamped by the host.
  load: (ctx) => ctx.api.cameraPositionHeatmap({ ...ctx.params, cellSize: ctx.settings.cellSize }),
  render: ({ data, ctx }) => <FloorPlanView bins={data} cellSize={ctx.settings.cellSize} />,
});
```

The host resolves `ctx.settings` (declared defaults overlaid with the viewer's saved overrides,
clamped/validated) and re-runs `load()` whenever a value changes. Every panel also gets a hide
("×") action and is restorable from a "Hidden panels" bar. Both visibility and settings persist
per surface in `localStorage` by default; embeds can plug in their own `PanelStateStore`.

Under live traffic, panels with a `load()` auto-refetch on the **overview** surface as events
arrive. The **session** drill-down is a frozen snapshot; a panel that should keep updating while
following an in-progress session subscribes via `ctx.live.subscribe(...)` and reacts to events
where `event.sessionId === ctx.sessionId`.

Panels are registered at **build time** by appending to the `builtinPanels` array in
the dashboard's `src/panels/registry.tsx`; the `PanelHost` filters by surface and each
panel's `enabled` gate and renders the bodies into the grid — no manual placement in
`page.tsx`.

### Loading panels at runtime (ADR 0041)

The dashboard can also discover and load panels from a **remote manifest at runtime**, so a
self-hoster adds a panel without rebuilding. It uses the same `PanelDefinition` contract — a panel
module you can `import()` in the browser. Runtime loading is **off by default**; enable it with a
build-time env var:

```bash
# One manifest, or a comma-separated list.
NEXT_PUBLIC_PANELS_MANIFEST_URL="https://panels.example.com/uptimizr.panels.json"
# Optional comma-separated allowlist of module origins.
NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS="https://panels.example.com"
```

A manifest lists panel modules and the contract major each targets
(`PANEL_CONTRACT_VERSION` from `@uptimizr/react`):

```json
{
  "version": 1,
  "panels": [
    {
      "id": "co2-budget",
      "url": "https://panels.example.com/co2-budget.js",
      "contract": 1,
      "export": "default"
    }
  ]
}
```

Remote panels execute **with the dashboard's full privileges** (no iframe/worker sandbox — that
would break the rich `PanelContext`), so only point the manifest at sources you trust; the origin
allowlist is a guardrail, not a sandbox. Loading is resilient: an unreachable/invalid manifest, an
incompatible `contract`, a blocked origin, a failed import, or a throwing `render` is isolated per
panel and surfaced in a "panels failed to load" banner without breaking the grid. See the
[Custom dashboard panels guide](https://uptimizr.com/docs/guides/custom-panels/) for a full
walkthrough.
