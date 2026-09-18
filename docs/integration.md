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
> bridge contract and per-engine native frames. The Godot bridged tier is **verified**
> by an automated headless Godot 4 Web export driven by Playwright in CI; the reference
> integration is [`examples/godot-web-export`](../examples/godot-web-export/README.md)
> (`pnpm godot:fetch && pnpm godot:export && pnpm test:e2e:godot`).
>
> **Unreal is alpha / best-effort** (ADR 0045 / #112): Epic has no official UE5 HTML5/WASM target
> (deprecated after UE 4.24) and Pixel Streaming is server-side, so the bridged tier targets
> the Emscripten-based, client-side web exports that do exist — the community UE4.24–4.27
> HTML5 forks and the experimental UE5.1–5.4 WASM+WebGPU toolchain (Wonder Interactive /
> SimplyStream). Its `EM_JS` / `cwrap` shim ships in
> [`@uptimizr/unreal`'s `bridge/`](../oss/packages/unreal/bridge/README.md) **unverified** (no
> buildable target to test against); the JS-only tier works on any web export regardless.

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

### Web-export engines (Unity / Godot / Unreal)

Engines that compile to **WebAssembly** and render into a `<canvas>` (Unity WebGL,
Godot Web, Unreal HTML5) have no live JS scene to read, so they don't use `trackScene`.
They share the [`@uptimizr/web-export`](../oss/packages/web-export/README.md) foundation
and capture in **two tiers**:

- **JS-only tier (no engine code).** `trackUnity` / `trackGodot` / `trackUnreal` start a
  client and capture pointer move/click heatmaps, FPS / long frames, and JS errors
  straight from the `<canvas>` DOM — immediately, with nothing added to the engine.
- **Bridged tier (a thin copy-in shim).** Camera pose, world-space picks, scene proxy,
  and replay need the engine to push its own world-space samples over a small versioned
  bridge. You copy a shim into the engine project; the engine is **not** an npm peer
  dependency.

```ts
import { trackUnity } from "@uptimizr/unity";

const { client, bridge } = trackUnity({
  projectId: "your-project-id",
  endpoint: "https://collect.example.com",
  canvas: () => document.querySelector("#unity-canvas"),
});

// later, on teardown
await client.stop("manual");
```

`trackUnity` registers the JS-only collector, starts the session with Unity's connector
provenance, and exposes the engine `bridge` on `window.__uptimizr_unity__` for the shim
to find.

**Unity bridged setup.** The shim is two copy-in files shipped in the package's
[`bridge/`](../oss/packages/unity/bridge) folder:

1. Copy `Uptimizr.jslib` to `Assets/Plugins/WebGL/Uptimizr.jslib` (Unity compiles
   `.jslib` files under `Plugins/WebGL` into the WebGL build).
2. Copy `UptimizrUnityBridge.cs` under `Assets/` and add the `UptimizrUnityBridge`
   component to a GameObject. It samples the active `Camera` pose, raycast picks (the hit
   GameObject's name + world point), and FPS each interval and pushes them over the
   bridge. It defaults to `Camera.main`.
3. Ensure `trackUnity(...)` runs on the host page **before** the export starts.

The bridged tier is **preview** until verified against a local build: the `.jslib` shim
is sanity-tested under `node:vm` on every `pnpm test`, and the sample Unity project in
[`examples/unity-web-export/`](../examples/unity-web-export) turns full verification into
a single **WebGL build** (Compression Format: Disabled) that
`examples/playground/e2e/unity-export.spec.ts` serves and drives; the spec skips when no
build is present.

Unity's native world frame is **left-handed, y-up, meters** — already Uptimizr's
canonical wire frame — so world-space payloads need no axis conversion; the connector
records the native frame as `connector.coordinateSystem` on `session_start`. The shim
does **no** coordinate math and sends only poses, FPS, and developer-named objects (no
invented IDs, no raw input text — ADR 0003). Godot (negate Z) and Unreal (z-up rebase +
cm→m scale) follow the same two-tier model with their own native frames; see the
[web-export connector docs](https://uptimizr.dev/connectors/web-export).

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
// or a completed XR tracking-degradation episode (#155, ADR 0048):
client.reportCapabilityChange({
  kind: "tracking",
  from: "hand",
  to: "lost",
  reason: "signal-lost",
  source: "hand",
  handedness: "left",
  durationMs: 1200,
});
```

`kind` is one of `graphics-backend` / `quality` / `device-recovery` / `tracking` /
`feature` / `other`; `from` / `to` / `reason` are optional, low-cardinality,
app-defined tokens (never raw device strings or PII, ADR 0003). The `tracking` kind
also carries the input `source` / `handedness` that degraded and an optional
`durationMs` (the completed degraded-episode length — one event per episode, emitted
on recovery), which powers the tracking-quality timeline (`GET /api/v1/xr/tracking`).
The Babylon connector reports coarse tracking loss/recovery automatically when a hand
or controller drops out of the input registry mid-session (toggle with the XR
capture option `tracking`, default on). This pairs with the raw `context_lost`
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

The declarative `@uptimizr/aframe` component takes the initial id as the `sceneId`
attribute (`<a-scene uptimizr="…; sceneId: level-1">`); switching at runtime is a
programmatic host's job via the re-exported `trackScene` client.

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

| Event                 | Source              | When                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewport_resize`     | `sdk-core`          | Window resized (debounced) + once at session start.                                                                                                                                                                                                                                                                                                                                                      |
| `focus_change`        | `sdk-core`          | Window gained/lost focus (`{ focused }`).                                                                                                                                                                                                                                                                                                                                                                |
| `visibility_change`   | `sdk-core`          | Tab shown/hidden (`{ state: "visible" \| "hidden" }`).                                                                                                                                                                                                                                                                                                                                                   |
| `context_lost`        | `@uptimizr/babylon` | Engine lost its GPU context (rendering suspended).                                                                                                                                                                                                                                                                                                                                                       |
| `context_restored`    | `@uptimizr/babylon` | Engine recovered its GPU context.                                                                                                                                                                                                                                                                                                                                                                        |
| `compile_stall`       | `@uptimizr/babylon` | Main-thread shader/pipeline compilation hitch (`durationMs`, `phase`).                                                                                                                                                                                                                                                                                                                                   |
| `capability_change`   | _app-reported_      | Fallback/recovery transition (`kind`, `from`, `to`, `reason`) — e.g. WebGPU→WebGL2, or an XR `tracking` degradation (`source`, `handedness`, `durationMs`; #155).                                                                                                                                                                                                                                        |
| `runtime_error`       | `sdk-core`          | Uncaught JS error / unhandled promise rejection (opt-in). Optional best-effort `position` (camera pose when it fired) powers the spatial error heatmap (#154).                                                                                                                                                                                                                                           |
| `graphics_diagnostic` | engine connector    | Opt-in GPU-health signal — today: WebGPU `device.lost` (`category: device-lost`), `uncapturederror` rollup (`validation`/`out-of-memory`), and context-creation failure (`category: context-loss`, `fatal`). Babylon + three; WebGL device-loss no-op. Optional best-effort `position` powers the spatial error heatmap (#154).                                                                          |
| `ar_placement`        | `@uptimizr/babylon` | AR object-placement settle (#156, ADR 0048): emitted **once per placement settle** (not per frame) for retail "view in your room" AR. Carries `mesh`, final world `position`, coarse `surface` (`floor`/`wall`/`table`/`ceiling`/`unknown`), `attempts` (re-placements), `timeToPlaceMs`, `scale` (1 = authored real-world size), and `final`. App-driven via `babylonArPlacementCollector` (see below). |

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
your app falls back (WebGPU→WebGL2), auto-downgrades quality/LOD, re-initialises
after a lost device, or observes XR tracking degrade (#155, ADR 0048), report the
transition with
`client.reportCapabilityChange({ kind, from?, to?, reason?, source?, handedness?, durationMs? })`
(`kind` is one of `graphics-backend` / `quality` / `device-recovery` / `tracking` /
`feature` / `other`). The `tracking` kind additionally carries the input
`source` / `handedness` that degraded and the completed episode's `durationMs`. It
pairs with the raw `context_lost` / `context_restored` events and explains perf and
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
  "position": [12.5, 1.7, -3.2], // optional [x,y,z]: camera position at the moment the error fired (#154)
}
```

Error payloads can carry user data (messages, stack frames, URLs), so capture is
**opt-in** and **not auto-redacted**. Sanitize or drop fields in your
[`beforeSend`](#advanced-setup-custom-client-beforesend) hook before they leave the
browser. To limit
noisy loops, consecutive identical `message`+`stack` errors are de-duplicated and
capture is capped at 50 events per session.

The optional `position` is the best-effort camera position at the moment the error
fired, stamped connector-side (Babylon reads the tracked camera's `globalPosition`;
other connectors omit it when no camera resolves). It reuses the promoted `position`
column and powers the [spatial **error heatmap**](#reads-the-query-api)
(`GET /api/v1/heatmaps/errors`) so you can see _where_ in the scene errors cluster,
not just _when_. It is additive and backward-compatible — older events simply omit it.

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
  "position": [12.5, 1.7, -3.2], // optional [x,y,z]: camera position when the diagnostic fired (#154)
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

### AR placement capture (WebXR "view in your room")

Retail AR placement is app-driven — only your app knows when the visitor enters
placement mode, taps to (re-)place the model, and finally commits it. Wire those
three moments (Babylon `Observable`s you already own) into
`babylonArPlacementCollector` and it emits exactly **one** `ar_placement` per settle
(#156, ADR 0048), counting re-placement `attempts`, timing `timeToPlaceMs`, and
classifying the coarse `surface` from the WebXR hit-test normal:

```ts
import { babylonArPlacementCollector } from "@uptimizr/babylon";

client.use(
  babylonArPlacementCollector({
    mesh: "Sofa",
    // Your placement UI's observables:
    onPlacementStartObservable, // fires with { mesh } when the user enters placement mode
    onPlaceObservable, // fires on each (re-)place with { position, normal? }
    onSettleObservable, // fires on confirm with { position, scale?, final? }
    // Optional: let the collector classify the surface for you.
    hitTest: xrHitTest, // Babylon WebXRHitTest feature (onHitTestResultObservable)
  }),
);
```

Signals are coarse and on-device only (ADR 0003): no plane polygons, no room
dimensions, no PII — only the coarse surface bucket, counts, and durations leave the
client; world `position` is voxel-binned downstream like every spatial signal. The
three query endpoints (`/api/v1/ar/placement/*`) power the dashboard's **AR placement
funnel** panel.

### Privacy

No cookies, no persistent client id; the `sessionId` is in-memory only. Never put
PII in `meta`, `track` props, or `user` — `user.id` must be pseudonymous/hashed
(ADR 0003). Per-session raw event retention (needed for replay) is opt-in on the
collector via `ENABLE_RAW_SESSION_RETENTION=true`, **and** reading a raw stream
additionally requires an API key holding the `query:raw`
[capability](#api-keys-capabilities-rate-limits-and-the-audit-log) — a plain
`query` key reads aggregates only, whatever retention is set to.

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

### WebXR in-scene hits (`xr.raycast`)

In an immersive session the three-based connectors map controller/gaze pose to
`pointer_move` rays and `select`/`squeeze` to `pointer_click` / `mesh_interaction`
(ADR 0011). Resolving those rays to a world hit (`hitPoint`/`hitMesh` on the ray
samples, the object a `mesh_interaction` attaches to) takes a probe:

- **`@uptimizr/three`** — `createXrRaycaster(scene, { maxDistance?, predicate? })` builds a world-space ray probe (single reused `THREE.Raycaster`; `uptimizr-` overlays skipped). Pass it as `trackScene(…, { xr: { raycast } })`. Without a probe, rays and clicks are still captured.
- **`@uptimizr/r3f`** — same `xr` option through `useUptimizr` / `<Uptimizr>`.
- **`@uptimizr/aframe`** — **on by default**: the component builds the probe over the live scene graph; `<a-scene uptimizr="…; xrRaycast: false">` opts out (rays + clicks only).

### Frame performance (`frame_perf`) fields

Beyond `fps`/`frameTimeMs`/`drawCalls`, each `frame_perf` sample reports
percentiles and render resolution measured over the sampling window:

| Field                              | Meaning                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `frameTimeP95Ms`, `frameTimeP99Ms` | 95th/99th-percentile frame time over the window (jank tail).                                                                                                                                                                                                                                                                                           |
| `longFrames`                       | Count of frames slower than `jankFrameMs` in the window.                                                                                                                                                                                                                                                                                               |
| `dpr`                              | Device pixel ratio.                                                                                                                                                                                                                                                                                                                                    |
| `renderScale`                      | Engine hardware-scaling factor (`1` = native, `<1` = downscaled).                                                                                                                                                                                                                                                                                      |
| `position`                         | Optional `[x, y, z]` camera world-position at the sample (#145). Lets the collector build a **spatial FPS heatmap** — _where_ FPS drops, not just _when_. The Babylon connector fills it from the tracked camera automatically; other connectors may set it on the emitted event. Omitted when no camera resolves, so it is fully backward-compatible. |

Because `frame_perf.position` reuses the same promoted `position` column as other
spatial events, no migration is needed and older SDKs (which never send it) keep
working — their perf samples simply don't appear in the spatial heatmap. The
collector exposes these binned samples at
[`GET /api/v1/heatmaps/perf`](#read-api), and the dashboard renders them as the
**Performance heatmap (3D)** panel (hot = slow: each voxel's colour/size scales
with slowness so your worst spots stand out, and hovering a cell shows its
avg/min FPS and sample count).

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

### Texture-space attention (`uv`) — automatic

When a pointer/gaze ray hits a mesh, the connector also reads the hit's **UV
(texture) coordinate** from the raycast result (Babylon
`PickingInfo.getTextureCoordinates()`) and attaches it as an optional
`uv: [u, v]` on `pointer_click`, `mesh_interaction`, and `hover_dwell` (#149). It
answers _where on a single object's surface_ attention lands — the per-mesh,
texture-space companion to the world-space heatmap. No configuration is required:
`uv` rides the existing `clicks` / `meshPicks` / `hoverDwell` capture channels and
is simply omitted when the engine can't resolve a coordinate (a mesh with no UVs,
a miss, or a non-Babylon connector that doesn't expose it yet).

`uv` is **not clamped** — values may fall outside `[0, 1]` under texture
wrapping/tiling, matching the engine's own coordinate. It rides in the event
`payload` (no promoted column, no migration), and the collector bins it into a
per-mesh grid via `GET /api/v1/heatmaps/mesh-uv` (§4), surfaced by the dashboard's
**Mesh UV heatmap** panel.

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

### API keys: capabilities, rate limits and the audit log

A key carries a **set of capabilities** (ADR 0051 §7), not a single role:

| Capability  | Grants                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `query`     | The aggregate analytics API — everything in the tables below, plus the scene registry, the live token exchange and `/api/v1/audit`. |
| `query:raw` | Raw **per-session** streams: `GET /api/v1/sessions/:id/events` and the live per-session follow `GET /api/v1/live/sessions/:id`.     |
| `annotate`  | The project **metadata** write path (annotations, glossary, saved analyses, panel specs). Never events — events stay read-only.     |
| `ingest`    | Reserved for server-side write paths. Public ingestion is keyless (see below), so issued keys are normally read keys.               |

`uptimizr init` and `uptimizr new-project` mint one key, the operator's **owner**
key: `query`, `query:raw` and `annotate`, labelled `owner`. That is the key the
dashboard, session replay, the live per-session follow and scene-region authoring
all run on, so none of them needs a second key later. `query:raw` is inert until
`ENABLE_RAW_SESSION_RETENTION` is also on (both halves of the gate are required),
so granting it up front turns nothing on.

Every other key comes from `uptimizr new-key` (ADR 0029), which stays read-only
(`query`) by default — the key to hand an agent or MCP client:

```bash
# A read-only key (the default)
uptimizr new-key <projectId> --label "weekly-report"

# An agent key that may also write metadata, with its own request budget
uptimizr new-key <projectId> \
  --capabilities query,annotate \
  --label "weekly-report-agent" \
  --rate-limit-max 120 --rate-limit-window-ms 60000

# A key that may read raw session streams (replay, live-follow)
uptimizr new-key <projectId> --capabilities query,query:raw --label "replay"
```

> **Breaking change (from the release that adds this section).** `query:raw` is
> new, and the raw per-session endpoints now require **both** halves of the gate:
> `ENABLE_RAW_SESSION_RETENTION` on the collector **and** `query:raw` on the key.
> Previously, retention alone was enough and any `query` key could read the raw
> stream. **Existing keys keep working for every aggregate endpoint**, but a key
> that drives session replay or live-follow must be re-minted with `query:raw`
> (or a new one issued alongside it). Keys minted by `uptimizr init` /
> `uptimizr new-project`, `pnpm db:seed` and the repo's local provisioning
> scripts already carry it.

**Per-key rate limits.** `--rate-limit-max` / `--rate-limit-window-ms` give a key
its own budget, bucketed on the key id rather than the client IP. Keys without
one fall back to the collector's `COLLECTOR_RATE_LIMIT_*` defaults. Ingestion is
deliberately untouched: it is keyless, and keeps its own
`COLLECTOR_INGEST_RATE_LIMIT_*` budget.

**`GET /api/v1/whoami`** reports the calling key's identity so an agent (or the
MCP server) can register only the tools its capabilities permit:

```json
{
  "projectId": "3f2a…",
  "keyId": "9c41…",
  "capabilities": ["query", "query:raw"],
  "label": "replay",
  "rateLimit": { "max": 600, "windowMs": 60000 },
  "rateLimitSource": "default"
}
```

`keyId` is the key's row id, never the key itself. `rateLimit` is always the
budget actually in force; `rateLimitSource` says whether it came from the key
(`"key"`) or the collector defaults (`"default"`).

**Agent audit log.** Every authenticated request made with a key that is not the
dashboard's own session is recorded: `{ id, projectId, keyId, at, surface,
toolOrPath, params, rowCount, durationMs, status }`. Refusals (401/403) are
recorded too — they are precisely what a project owner wants to see.

- `toolOrPath` is the **route pattern** (`/api/v1/sessions/:id/events`), so rows
  group cleanly and never carry a path-embedded value.
- `params` is a bounded (512-byte) JSON document with credential-shaped keys
  (`token`, `apiKey`, `secret`, `password`, `authorization`, …) dropped, nested
  values summarized, and long strings clipped. **A key never appears in a row.**
- `surface` is `http` today; `mcp-http` / `mcp-stdio` / `assistant` are reserved
  for the later agent transports.
- "The dashboard's own session" means a request carrying
  `x-uptimizr-client: dashboard` — the header `@uptimizr/react`'s `CollectorApi`
  sends by default, so a dashboard's panel refreshes do not drown the agent
  activity the log exists to surface. The in-browser assistant identifies itself
  as `assistant` and **is** recorded. This is a volume filter, not a security
  boundary: anyone holding the key could send the header, and anyone holding the
  key can already do everything the key allows. Set `AUDIT_DASHBOARD_REQUESTS=1`
  to record every authenticated request without exception.
- Writes are asynchronous — they happen after the response is flushed and can
  never block or fail a request.
- Rows older than `AUDIT_RETENTION_DAYS` (default `30`) are removed by a
  periodic, idempotent sweep. `0` keeps them indefinitely.

```bash
# The project's agent activity, newest first (needs a `query` key)
curl -H "x-api-key: $KEY" \
  "$COLLECTOR/api/v1/audit?since=1757000000000&limit=100"
```

| Method | Path             | Purpose                                                                          | Capability | Extra params              |
| ------ | ---------------- | -------------------------------------------------------------------------------- | ---------- | ------------------------- |
| `GET`  | `/api/v1/whoami` | The calling key's project, key id, capabilities, label and effective rate limit. | `query`    | —                         |
| `GET`  | `/api/v1/audit`  | The project's agent audit trail, newest first.                                   | `query`    | `since`, `until`, `limit` |

### Storage backends (`COLLECTOR_STORE`)

The API is identical whichever store backs it — the dashboard, SDKs and this
reference never see the engine (ADR 0020). Select the store with
`COLLECTOR_STORE`:

| Store        | When to use                                                                                                       | Connection settings                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duckdb`     | **Default.** Single-file embedded store, zero services, one collector process per file.                           | `DUCKDB_PATH` (default `./data/uptimizr.duckdb`)                                                                                                                                                                      |
| `postgres`   | You already run PostgreSQL and want a multi-writer relational backend (several collector instances).              | `POSTGRES_URL` (or `DATABASE_URL`), optional `POSTGRES_SCHEMA` (`public`), `POSTGRES_POOL_MAX` (`10`)                                                                                                                 |
| `mssql`      | Your team is standardized on Microsoft SQL Server / Azure SQL and wants the same multi-writer relational backend. | `MSSQL_URL` (ADO.NET connection string) or `MSSQL_SERVER` / `MSSQL_PORT` / `MSSQL_DATABASE` / `MSSQL_USER` / `MSSQL_PASSWORD` (+ `MSSQL_ENCRYPT`, `MSSQL_TRUST_SERVER_CERTIFICATE`), optional `MSSQL_POOL_MAX` (`10`) |
| `clickhouse` | High-volume ingestion / large historical ranges (the scale tier).                                                 | `CLICKHOUSE_URL`, `CLICKHOUSE_DATABASE`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`                                                                                                                                     |
| `memory`     | Dependency-free in-memory store for local dev / E2E only.                                                         | `COLLECTOR_MEMORY_PROJECT_ID`, `COLLECTOR_MEMORY_API_KEY`                                                                                                                                                             |

Every analytics endpoint below returns **identical results** on all four SQL
stores — each aggregation is authored once against the dialect-agnostic query
layer in `@uptimizr/db` and verified by the cross-engine parity suite. On
Postgres and SQL Server the ASOF (nearest-in-time) joins behind the click↔gaze
ray, flow, reachability and navigation reads are emulated with an indexed
nearest-row lookup (`LATERAL` / `CROSS APPLY`), and the daily rollups are
recomputed at query time; SQL Server additionally stores vector columns as JSON
arrays and computes percentiles through a small T-SQL helper function. See the
[self-hosting guide](https://uptimizr.com/docs/deploy/collector/) for the
full walkthrough of each store.

### Ingestion

| Method | Path              | Notes                                                                                                          |
| ------ | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/v1/collect` | Batched events. The SDK uses `navigator.sendBeacon` (credentialed) and falls back to `fetch` with `keepalive`. |

### Query (read)

> Querying this API as a contributor or agent? See the
> [`query-analytics`](../.github/skills/query-analytics/SKILL.md) skill for the workflow, unit
> pitfalls, and the read-only [`@uptimizr/mcp`](../oss/packages/mcp/README.md) server. The tool
> catalog behind MCP lives in the framework-agnostic
> [`@uptimizr/agent-core`](../oss/packages/agent-core/README.md) package (one read-only entry per
> endpoint below, plus a headless provider-adapter interface and tool-calling loop), so the same
> contract drives MCP and any in-browser or headless agent without duplication (ADR 0050). That
> catalog is **generated** from the semantic metric registry in
> [`@uptimizr/metrics`](../oss/packages/metrics/README.md) (ADR 0051 §1): every read endpoint with a registry
> entry is a tool (69 today), each carrying the metric's interpretation notes and caveats and an
> output schema for its rows. Adding an endpoint without a registry entry fails the build, so the
> agent surface cannot fall behind this table.
>
> Beyond tools, the MCP server exposes capability-discovery **resources** —
> `uptimizr://capabilities` (a machine-readable descriptor of event types, the tool catalog, and
> parameter semantics) and `uptimizr://scenes` (the live scene ids) — plus curated **prompts**
> (`weekly_scene_health`, `attention_hotspots`, `xr_comfort_review`) that drive the existing tools.
> A Streamable HTTP
> transport is a deferred, auth-gated follow-up (ADR 0050 §7). See the
> [MCP guide](https://uptimizr.com/docs/guides/mcp/) for the full resource/prompt/tool reference.

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
correctly).

`region` also accepts the **id of a registered scene region** — `region=entrance`
instead of six numbers (ADR 0051 §2, see
[Scene regions](#scene-regions-named-places)). The collector resolves the id to
that region's stored box before the query runs, so named drill-down and ad-hoc
boxes behave identically. A region is defined within a scene, so the request must
also pass `scene=`; an id the project has never registered returns `400` (never a
silently empty result). The dashboard's 3D world heatmap also normalizes color/size to the
95th-percentile cell, so a few hotspots no longer wash out the rest of the scene.

#### Result formats (`format=full | table | summary`)

Every aggregate endpoint in the table below accepts a shared `format` parameter
(ADR 0051 §2). It narrows nothing — it selects the **envelope** the rows come
back in. Omit it and nothing changes: `full` is the default and returns exactly
the bare rows it always has, which is what the dashboard uses.

`table` keeps the rows and adds a `meta` envelope, so a result is
self-describing without a second lookup:

```jsonc
// GET /api/v1/meshes/top?since=…&format=table
{
  "meta": {
    "metric": "top_meshes",
    "range": { "since": 1757000000000, "until": 1757600000000 },
    "filters": { "scene": "lobby", "limit": 50 },
    "sampleSize": { "sessions": null, "events": 9130 },
    "rows": 63,
    "truncated": false,
    "limits": { "maxRows": 1000, "maxSummaryRows": 10 },
  },
  "rows": [{ "mesh": "checkout_button", "count": 2210 }],
}
```

`summary` is the one to reach for from an agent: a **bounded** digest capped at
the metric's `limits.maxSummaryRows`, so a 500-bin heatmap costs the same number
of tokens as a 5-bin one. Its shape follows the metric's grain:

| Grain              | `kind`     | What you get                                                                    |
| ------------------ | ---------- | ------------------------------------------------------------------------------- |
| mesh/scene/session | `ranked`   | `top[]` (label, value, share, Wilson interval, drill hints) and a `rest` bucket |
| `bucket`           | `series`   | `first` / `last` / `min` / `max` / `trend` / `slope` over the ordered axis      |
| `bin`, `voxel`     | `clusters` | merged hotspots — centroid, extent, cells, weight, share                        |
| `project`          | `record`   | the single row, plus every rate the registry declares via `rateOf`              |

```jsonc
// GET /api/v1/meshes/top?since=…&format=summary
{
  "kind": "ranked",
  "metric": "top_meshes",
  "range": { "since": 1757000000000, "until": 1757600000000 },
  "filters": { "scene": "lobby" },
  "sampleSize": { "sessions": null, "events": 9130 },
  "total": 9130,
  "measure": { "column": "count", "unit": "count", "additive": true },
  "top": [
    {
      "label": "checkout_button",
      "value": 2210,
      "share": 0.242,
      "shareInterval": { "low": 0.233, "high": 0.251 },
    },
    { "label": "door_left", "value": 1490, "share": 0.163 },
  ],
  "rest": { "rows": 61, "value": 5430, "share": 0.595 },
  "confidence": {
    "kind": "wilson",
    "level": 0.95,
    "note": "Shares are proportions of 9130 events; …",
  },
  "reading": "Most-interacted meshes: checkout_button leads on count with 2,210 (24.2% of 9,130), followed by door_left with 1,490 (16.3%). The remaining 61 meshes hold 59.5%. Sample: 9,130 events.",
  "caveats": ["Rows backed by fewer than ~30 events are directional only — …"],
}
```

Worth knowing before you build on it:

- **`reading` is templated, never generated.** It is assembled from the metric's
  registry column semantics (`unit`, `label`, `measure`, `rateOf`) by pure code in
  `@uptimizr/db` — no model is involved, so the same rows always produce the same
  sentence.
- **`sampleSize` is derived from column units.** `sessions` is the row count when
  one row _is_ a session, otherwise the sum of the first column declared
  `unit: "sessions"` (an upper bound when rows can share a session); `events` is
  the sum of the first column declared `unit: "count"`. Either is `null` when the
  metric declares nothing that could answer the question — never `0`.
- **Shares are only reported where they are true.** A measure in FPS, a ratio or a
  percentile cannot be summed across rows, so `total` and every `share` come back
  `null` and the `reading` says why. `confidence` (a 95% Wilson interval, which
  stays inside `0..1` at the small counts a long tail produces) appears only when
  the shares really are proportions of a count.
- **Clusters are merged, then named.** A `bin`/`voxel` summary merges adjacent
  occupied cells whose weight clears a density threshold (the mean weight per
  occupied cell; 8-neighbourhood for 2D bins, 26 for voxels) and ranks them by
  summed weight. Coordinates are **grid indices** — multiply by the effective
  `cellSize` to place them. Where the metric accepts `region`, each cluster also
  carries a `drill.region` hint you can send straight back — see
  [labelled clusters](#labelled-clusters) below.
- **`drill` hints are actionable.** A hint only names a filter the metric itself
  accepts, so re-issuing the query with it always narrows the result.
- An unknown `format` is a `400`. Note that `GET /api/v1/sessions/:id/events`
  has its own, older `format=json|ndjson` for the raw replay stream — that route
  is not an aggregate and is unaffected.

##### Labelled clusters

A world-space hotspot reported as `centroid: [7, 2, 11]` tells a reader nothing.
When the selected scene has a registered [proxy](#scene-registry-representations)
and [regions](#scene-regions-named-places), every cluster of a world-space heatmap
(`world_heatmap`, `gaze_heatmap`, `position_heatmap`, `click_rays`,
`scene_coverage`, the error and boundary heatmaps, aggregate paths and
trajectories) is labelled with the scene's own vocabulary:

| Field         | What it is                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `region`      | the **smallest** containing region by volume, or `null` when none contains it                   |
| `regions`     | _every_ containing region id, ascending — regions may overlap                                   |
| `nearestMesh` | a proxy mesh whose box contains the centroid, else the nearest box centre within `cellSize × 2` |
| `distance`    | world units to that mesh, `0` when its box contains the hotspot                                 |

```jsonc
// GET /api/v1/heatmaps/world?scene=lobby&format=summary
{
  "kind": "clusters",
  "axes": ["vx", "vy", "vz"],
  "clusters": [
    {
      "centroid": [7, 2, 11],
      "extent": { "min": [6, 2, 10], "max": [8, 3, 12] },
      "cells": 14,
      "weight": 2210,
      "share": 0.242,
      "region": "counter",
      "regions": ["counter", "shop-floor"],
      "nearestMesh": "checkout_button",
      "distance": 0,
      "drill": { "region": "counter" },
    },
  ],
  "reading": "3D world-space pointer heatmap: 3 hotspots over 412 occupied voxels. The densest spans 3x2x3 voxels on `checkout_button` in region `counter`, centred at (7, 2, 11) on vx/vy/vz, holding 2,210 (24.2%). …",
}
```

Notes:

- The scene is the request's `scene` filter, or the project's only registered
  scene when it has exactly one. With several scenes and no filter, nothing is
  labelled — the collector will not guess which vocabulary applies.
- **`drill.region` becomes the region id** once a region contains the hotspot,
  because `?region=<id>` resolves server-side to that region's stored box. Without
  a containing region it stays the ad-hoc `minX,…,maxZ` world box.
- **`null` is honest, not missing.** A scene with no proxy gets `nearestMesh: null`
  plus the caveat _"No proxy registered for scene `lobby` …"_; a scene with no
  regions gets `region: null` and the matching caveat. A mesh further than
  `cellSize × 2` is reported as `null` rather than guessed.
- Grids that are not world-space — the viewport pointer/UV bins (`gx`/`gy`) and
  the angular view-direction grid — carry no label fields at all.
- Labelling is `summary`-only. `full` and `table` return exactly the rows they
  always have.

**Machine-readable reference.** The collector serves an OpenAPI 3.1 document for everything below at
**`GET /api/v1/openapi.json`** — unauthenticated, because it is documentation and contains no project
data. It is generated from the same [semantic metric registry](./adr/0051-ai-first-analytics-layer.md)
as the table below, so it lists exactly the aggregations that collector can compute, with each
parameter's real validation schema and each response's row schema. The semantics OpenAPI cannot
express travel as `x-uptimizr-*` extensions per operation: `grain` (what one row is), per-column
`units`, `caveats`, `interpretation`, `source-channels`, `dimensions` and `limits`. Point an API
explorer at it, or generate a typed client
(`npx openapi-typescript <collector>/api/v1/openapi.json -o collector.d.ts`).

The table below is **generated** from the metric registry (`pnpm gen:docs`); CI fails when it drifts.

<!-- generated:registry-endpoints:start — generated by `pnpm gen:docs`; edit the metric registry, not this table -->

| Method | Path                                     | Metric                       | Purpose                                                                                                                                                                                                                                                                                    |
| ------ | ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/api/v1/sessions`                       | `list_sessions`              | One row per session seen in the range: its id, the server-derived daily-rotating visitor hash, how many events it produced, and its first/last event timestamps. The entry point for 'what traffic did this project get' and for picking a session to drill into.                          |
| `GET`  | `/api/v1/sessions/:id/meta`              | `session_meta`               | The coarse descriptor for one session — start time, the device/graphics block reported at `session_start`, the scene metadata and the app-supplied anonymous user descriptor. A single-object resource read from the store, not an aggregation, and deliberately not the raw event stream. |
| `GET`  | `/api/v1/scenes/:sceneId/representation` | `scene_representation`       | The registered proxy geometry for one scene (ADR 0014): its world bounds, up-axis and unit scale, and the named proxy boxes when one was uploaded. A metadata resource read, not an aggregation — it is what turns the voxel coordinates of the spatial metrics into named places.         |
| `GET`  | `/api/v1/scenes`                         | `list_scenes`                | The distinct developer-assigned scenes (ADR 0010) that saw activity in the range, with their event count and most recent activity. One row per scene; the orientation query before any scene-scoped question.                                                                              |
| `GET`  | `/api/v1/timeseries`                     | `timeseries`                 | Event volume bucketed into fixed `interval`-second windows, with the average FPS of any `frame_perf` samples in the same bucket. One row per bucket: the shape of traffic with the coarse perf trend beside it.                                                                            |
| `GET`  | `/api/v1/event-counts`                   | `event_counts`               | How many events of each type were recorded in the range, optionally for one scene. One row per event type. The scene-health overview: error rate, context losses, focus/visibility gaps and interaction volume all read off this single query.                                             |
| `GET`  | `/api/v1/heatmaps/pointer`               | `pointer_heatmap`            | Screen-space pointer activity binned into a `bins × bins` grid over the normalized viewport. One row per occupied cell. Answers 'where on screen do people point and click' — the classic web heatmap, for a 3D canvas.                                                                    |
| `GET`  | `/api/v1/heatmaps/mesh-uv`               | `mesh_uv_heatmap`            | Interaction hits on one object binned into a `bins × bins` grid over that object's own `[0,1]` UV space (#149). One row per occupied cell. Answers 'which part of this product model gets attention', independent of where the object sits in the scene.                                   |
| `GET`  | `/api/v1/heatmaps/world`                 | `world_heatmap`              | Pointer raycast hit points voxel-binned into a uniform grid of `cellSize`-sized cubes. One row per occupied voxel, busiest first. Answers 'where in the scene do people point and click' in world coordinates rather than on screen.                                                       |
| `GET`  | `/api/v1/heatmaps/world/stats`           | `world_heatmap_stats`        | The un-truncated totals behind `world_heatmap` (ADR 0040 §3): how many voxels are occupied and how many hits they hold, computed with no row cap. Always a single row.                                                                                                                     |
| `GET`  | `/api/v1/heatmaps/gaze`                  | `gaze_heatmap`               | Where the camera-forward (gaze) ray landed on real geometry, voxel-binned into a uniform grid (ADR 0030). One row per occupied voxel, busiest first. This is 'what did people actually look at', as opposed to what they clicked.                                                          |
| `GET`  | `/api/v1/heatmaps/gaze/stats`            | `gaze_heatmap_stats`         | The un-truncated totals behind `gaze_heatmap` (ADR 0040 §3): occupied voxels and total gaze hits, with no row cap. Always a single row.                                                                                                                                                    |
| `GET`  | `/api/v1/heatmaps/camera`                | `camera_heatmap`             | Camera forward vectors binned by spherical angle into a `bins × bins` azimuth/elevation grid. One row per occupied direction bin. The abstract 'which way did people look' dome — it needs no scene geometry, so it works even without the gaze raycast.                                   |
| `GET`  | `/api/v1/coverage/view-histogram`        | `view_coverage_histogram`    | How much of the view dome each session actually looked at, bucketed across sessions (#146). One row per 25-point coverage band. Answers 'how many visitors saw less than a quarter of the product'.                                                                                        |
| `GET`  | `/api/v1/heatmaps/position`              | `position_heatmap`           | Camera positions binned onto the X/Z ground plane in `cellSize`-sized cells, with the mean height per cell (ADR 0026). One row per occupied cell, busiest first. The 'where do visitors stand and linger' map for a walkable scene.                                                        |
| `GET`  | `/api/v1/sessions/:sessionId/trajectory` | `session_trajectory`         | One session's ordered camera positions, oldest first (ADR 0026). One row per sampled point. The single-visitor path behind the crowd view in `aggregate_paths`.                                                                                                                            |
| `GET`  | `/api/v1/paths`                          | `aggregate_paths`            | Every session's camera path binned onto the ground grid and returned as ordered, session-keyed points (#73, ADR 0037). One row per (session, sampled point). Overlaying the poly-lines makes the routes visitors actually walk self-reinforce into desire lines.                           |
| `GET`  | `/api/v1/coverage`                       | `scene_coverage`             | Camera _positions_ voxel-binned into a uniform 3D grid. One row per occupied voxel with its visit count. Exploration completeness and never-visited regions are computed by comparing the occupied voxels against the scene's registered bounds.                                           |
| `GET`  | `/api/v1/camera/distance`                | `camera_distance`            | Histogram of the distance from each camera sample to a reference point (by default the world origin; pass the scene-AABB centre for a product view). One row per `bucketSize`-wide distance band. A proxy for engagement intensity — how close visitors get to the subject.                |
| `GET`  | `/api/v1/heatmaps/click-rays`            | `click_rays`                 | Each click aggregated into a ray from an origin voxel to the hit voxel, sharing the world heatmap's grid. One row per (origin voxel, hit voxel, mesh). Shows not just _what_ was clicked but _from where_ — the standpoint an interaction was made from.                                   |
| `GET`  | `/api/v1/heatmaps/flow`                  | `flow_links`                 | Weighted links from a camera-direction bin to the mesh that was clicked while facing that way. One row per (direction bin, mesh), or per (standpoint voxel, direction bin, mesh) in position-aware mode. Connects where people looked from to what they acted on.                          |
| `GET`  | `/api/v1/meshes/top`                     | `top_meshes`                 | Meshes ranked by how many events referenced them. One row per mesh. The 3D analogue of a top-pages report: which objects in the scene draw activity.                                                                                                                                       |
| `GET`  | `/api/v1/meshes/sources`                 | `mesh_sources`               | The mesh leaderboard broken out by the input source that drove each interaction (#74, ADR 0011). One row per (mesh, source). Scoped to **active** interactions, so passive gaze never inflates popularity.                                                                                 |
| `GET`  | `/api/v1/meshes/trend`                   | `mesh_trend`                 | The active-interaction tally per mesh, bucketed into fixed `interval`-second windows (#74). One row per (mesh, bucket), oldest bucket first — the per-mesh sparkline behind the leaderboard.                                                                                               |
| `GET`  | `/api/v1/meshes/dwell`                   | `mesh_dwell`                 | How long each object spent on screen and near the view centre, from `mesh_visibility` summaries (#37). One row per mesh, ranked by total on-screen time. The 3D analogue of time-on-element.                                                                                               |
| `GET`  | `/api/v1/meshes/blind-spots`             | `mesh_blind_spots`           | Per mesh, how long it was visible against how much it was engaged with (#143). One row per mesh that was seen at least once, most-seen-yet-least-touched first. A product detail with high visibility and near-zero interaction is a blind spot.                                           |
| `GET`  | `/api/v1/meshes/kinds`                   | `mesh_interaction_kinds`     | Per-mesh counts of each interaction _kind_ — hover, pick, click, drag, select, squeeze, grab, release, teleport (#72, ADR 0023). One row per (mesh, kind). Separates an object that is merely hovered from one that is actually picked or dragged.                                         |
| `GET`  | `/api/v1/meshes/reachability`            | `mesh_reachability`          | How far each interacted mesh sat from where the visitor actually stood (#151). One row per (mesh, distance band) with the mean distance in the band. Meshes whose interactions cluster in far bands are consistently reached from an uncomfortable range.                                  |
| `GET`  | `/api/v1/clicks/dead`                    | `dead_clicks`                | Of all clicks in the range, how many hit nothing at all (#46). Always a single row. A high dead-click share is a 3D discoverability problem: visitors click where they expect something interactive and get no response.                                                                   |
| `GET`  | `/api/v1/clicks/rage`                    | `rage_clicks`                | Rapid repeated clicks on the same mesh inside one time window (#47) — the 'I keep clicking and nothing happens' frustration signal. One row per (session, mesh, window) that reached `minRepeats`, biggest burst first.                                                                    |
| `GET`  | `/api/v1/hover/dwell`                    | `hover_dwell`                | Per mesh, how long visitors lingered on an object _without clicking it_, over how many episodes, and the longest single hover (#48). One row per mesh. High dwell with few interactions flags objects that look interactive but are not.                                                   |
| `GET`  | `/api/v1/interactions/sources`           | `interaction_sources`        | For every interaction event that carries an input source, how many fired per (event type, source) and across how many distinct sessions (ADR 0011). One row per pairing. Turns `source` from a filter into the modality mix of the audience.                                               |
| `GET`  | `/api/v1/input-actions/top`              | `top_input_actions`          | App-level `input_action` labels — bound keyboard chords and gamepad buttons — ranked by how often they fired, split by input source (#75, ADR 0023). One row per (action, source).                                                                                                         |
| `GET`  | `/api/v1/camera-gestures`                | `camera_gestures`            | How often visitors moved the viewpoint and for how long, per gesture kind — orbit, pan, dolly, zoom, roll, fly, navigate (ADR 0025). One row per kind. Separates deliberate navigation intent from object selection.                                                                       |
| `GET`  | `/api/v1/navigation`                     | `navigation_stats`           | Per session, how far the camera travelled and how much of that travel was active rather than idle dwell. One row per session. A high segment count with low active distance flags a stuck or lost visitor.                                                                                 |
| `GET`  | `/api/v1/backtrack`                      | `backtrack_ratio`            | Per scene, the share of coarse-grid cell entries that re-entered an already-visited cell (#153). One row per scene. A high ratio flags a dead end, a missed cue, or a puzzle that is not reading clearly.                                                                                  |
| `GET`  | `/api/v1/perf`                           | `perf_summary`               | The pooled FPS headline over the range: how many `frame_perf` samples were seen and their average, minimum and median FPS. Always a single row. The quickest 'is this scene smooth' check.                                                                                                 |
| `GET`  | `/api/v1/perf/render-scale`              | `render_scale_truth`         | The FPS headline paired with the resolution the engine actually rendered at (#71, ADR 0021). Always a single row. A scene can report a healthy frame rate only because an adaptive renderer quietly dropped the render scale below 1.                                                      |
| `GET`  | `/api/v1/perf/distribution`              | `perf_distribution`          | FPS percentiles computed per session and then aggregated (ADR 0028 §1): the median across sessions of each session's p05 / p50 / p95. Always a single row. The honest smoothness headline — one visitor, one vote.                                                                         |
| `GET`  | `/api/v1/perf/fps-histogram`             | `fps_histogram`              | How many sessions fell into each FPS band, where a session contributes a single data point — its median FPS (ADR 0028 §1). One row per `bucket`-wide band. Answers 'how many _experiences_ were smooth', not how many frames.                                                              |
| `GET`  | `/api/v1/perf/frame-time`                | `frame_time_percentiles`     | Frame cost in milliseconds, computed per session then aggregated (ADR 0028 §1): the typical frame and the tail. Always a single row. Milliseconds are the budget developers actually work in — FPS is the reciprocal.                                                                      |
| `GET`  | `/api/v1/perf/jank`                      | `jank_rate`                  | How often frames ran long, per session then aggregated (ADR 0028 §1): the median session's long-frames-per-window rate and the worst decile's. Always a single row. Surfaces the janky minority instead of averaging it away.                                                              |
| `GET`  | `/api/v1/perf/churn`                     | `perf_churn`                 | Does a stutter actually cost sessions (#144)? Of the sessions that ended in range, how many ended shortly after an FPS dip or a compile stall, with the cause attributed. Always a single row of aggregate counts.                                                                         |
| `GET`  | `/api/v1/perf/by-device`                 | `perf_by_device`             | Median FPS attributed to the graphics backend, mobile flag, GPU renderer and the coarse browser/OS families derived at ingestion (ADR 0028 §2, ADR 0042). One row per device combination. Where a bimodal FPS histogram gets explained.                                                    |
| `GET`  | `/api/v1/perf/by-scene`                  | `perf_by_scene`              | Median FPS attributed to each scene, per session then aggregated (ADR 0028 §1). One row per scene. The comparison that tells you which level is expensive.                                                                                                                                 |
| `GET`  | `/api/v1/heatmaps/perf`                  | `perf_heatmap`               | `frame_perf` samples voxel-binned by the camera position they were captured at (#145), with each cell's sample count, mean FPS and worst sample. One row per occupied voxel, worst-FPS-first. Answers _where_ performance degrades.                                                        |
| `GET`  | `/api/v1/perf/compile-stalls`            | `compile_stalls`             | Per compile phase, how many main-thread compile hitches happened and their total, average and worst duration (#42). One row per phase. Compilation is the biggest single source of first-interaction jank, and frame-rate averages hide it.                                                |
| `GET`  | `/api/v1/perf/resources`                 | `resource_summary`           | The average and peak of each footprint metric over the range (#44): JS heap, submitted triangles and vertices, resident texture and geometry bytes. Always a single row — the actual cost the scene asked of the device.                                                                   |
| `GET`  | `/api/v1/perf/resource-percentiles`      | `resource_percentiles`       | Footprint percentiles computed per session then aggregated (ADR 0028 §1): a typical (p50) and peak (p95) JS heap, texture bytes and triangle count per session, summarised as the median across sessions. Always a single row.                                                             |
| `GET`  | `/api/v1/perf/stability`                 | `stability_counts`           | GPU context losses and shader/pipeline compile stalls over the range, plus their total. Always a single row. These are the hard failures a frame-rate average cannot show — a context loss blanks the canvas, a compile stall freezes first interaction.                                   |
| `GET`  | `/api/v1/graphics-diagnostics`           | `graphics_diagnostics`       | Opt-in engine diagnostics crossed by (severity, category, backend) with a rollup-aware incident total (ADR 0021 part 2). One row per combination. Surfaces validation errors, shader-compile failures and context-loss detail the engine reports.                                          |
| `GET`  | `/api/v1/heatmaps/errors`                | `error_heatmap`              | Positioned runtime errors and engine diagnostics voxel-binned into a uniform grid (#154). One row per occupied voxel, busiest first. Reveals _where_ in the scene things break, not only when.                                                                                             |
| `GET`  | `/api/v1/rendering-technology`           | `rendering_technology`       | Session counts crossed by (api, backend, api version, shading language) from the always-on `session_start` graphics block (ADR 0021 part 1, ADR 0046). One row per combination — WebGPU vs WebGL2 adoption, and which shading language is in play.                                         |
| `GET`  | `/api/v1/capabilities`                   | `capability_changes`         | How often the app reported a capability fallback or recovery, per (kind, from, to) (#49). One row per transition. Explains perf and visual-fidelity variance — e.g. how many sessions fell back from WebGPU to WebGL2.                                                                     |
| `GET`  | `/api/v1/xr/rotation`                    | `xr_rotation`                | Per session, how fast the view turned over the camera pose stream — the angular path, the worst single jerk, and how many steps cleared the rapid-turn threshold. One row per session. A motion-sickness proxy.                                                                            |
| `GET`  | `/api/v1/xr/sources`                     | `xr_sources`                 | The immersive input mix: one row per XR input source (hand, controller, gaze, transient) with its interaction count and how many sessions used it. Flat-screen sources are excluded so the split is purely XR.                                                                             |
| `GET`  | `/api/v1/xr/abandonment`                 | `xr_abandonment`             | For every session that used an XR input source, its wall-clock bounds and event / interaction counts. One row per XR session. A short span with few interactions is headset drop-off.                                                                                                      |
| `GET`  | `/api/v1/xr/locomotion`                  | `xr_locomotion`              | Per XR session, its locomotion-style mix — fly and navigate gestures, discrete teleports, and total time in locomotion — plus the session's wall-clock span (#148). One row per XR session. Constant smooth locomotion is a motion-sickness risk; teleport-dominant sessions are not.      |
| `GET`  | `/api/v1/xr/tracking`                    | `xr_tracking_quality`        | Per session that reported a tracking transition, how much of it ran with degraded or lost spatial tracking, split by hand vs controller (#155, ADR 0048). One row per session. A session that looked fine on FPS can still have been unusable because the hands kept disappearing.         |
| `GET`  | `/api/v1/heatmaps/boundary`              | `boundary_heatmap`           | Where room-scale VR visitors approached their play-space boundary, voxel-binned into a uniform grid (#157, ADR 0048). One row per occupied voxel, busiest first. The 'where did people keep bumping into their guardian' map.                                                              |
| `GET`  | `/api/v1/heatmaps/boundary/stats`        | `boundary_heatmap_stats`     | The un-truncated totals behind `boundary_heatmap` (ADR 0040 §3): occupied voxels and total boundary contacts, with no row cap. Always a single row.                                                                                                                                        |
| `GET`  | `/api/v1/xr/boundary-contacts`           | `xr_boundary_contacts`       | For every session that touched its play-space boundary, how many approaches it made and how long it spent in the near-boundary zone (#157, ADR 0048). One row per session. Frequent contact means the physical space did not fit the experience.                                           |
| `GET`  | `/api/v1/ar/placement/time-to-place`     | `ar_placement_time_to_place` | How long visitors took to place a model on a surface, histogrammed into `bucketMs`-wide bins (#156, ADR 0048 §1). One row per bin, one settle per data point. The felt cost of getting a 'view in your room' model down — the AR analogue of a slow add-to-cart.                           |
| `GET`  | `/api/v1/ar/placement/attempts`          | `ar_placement_attempts`      | How many place / re-place actions visitors made before committing (#156, ADR 0048 §1). One row per attempt count. `attempts = 1` is a clean first try; a long right tail is placement friction.                                                                                            |
| `GET`  | `/api/v1/ar/placement/surfaces`          | `ar_placement_surfaces`      | Per coarse surface bucket — floor, wall, table, ceiling, unknown — how many settles landed there and their average committed scale (#156, ADR 0048 §1). One row per surface. Shows where visitors place models and how far off the authored size they settle.                              |
| `GET`  | `/api/v1/funnel`                         | `funnel`                     | An ordered, per-session conversion funnel over caller-supplied step predicates (ADR 0038): how many sessions reached each step in order. One row per step, 0-based. The OSS collector has no authoring surface, so the steps come from the caller.                                         |
| `GET`  | `/api/v1/scene-retention`                | `scene_retention`            | Directed scene→scene links weighted by how many distinct sessions made each consecutive transition (#147), derived purely from the observed order of `scene_change` markers. One row per link, busiest first. The zero-config level funnel.                                                |
| `GET`  | `/api/v1/load-bounce`                    | `load_bounce_funnel`         | Sessions bucketed by their initial load time, with how many bounced in each band (#152) — a bounce being a session that produced no interaction at or after its first asset load. One row per band. Turns 'slow loads cost you customers' into a number.                                   |
| `GET`  | `/api/v1/variant-leaderboard`            | `variant_leaderboard`        | For a product configurator (#150): per variant — a custom event grouped by its name — how often it was viewed, over how many sessions, how many of those converted, and the mean dwell before the visitor switched or converted. One row per variant, ranked by views.                     |

<!-- generated:registry-endpoints:end -->

The read routes that are **not** registry metrics are the raw per-session event stream that replay
uses, and the two routes that describe the _calling key_ rather than the project's telemetry. None
of them aggregates anything, so none of them takes `format` — a stray `format=` on them is ignored:

| Method | Path                          | Purpose                                                                                                                                                                                         |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/sessions/:id/events` | Ordered raw event stream for replay. Requires **both** `ENABLE_RAW_SESSION_RETENTION` on the collector (ADR 0003) and the `query:raw` capability on the key (ADR 0051 §7); otherwise `403`.     |
| `GET`  | `/api/v1/whoami`              | The calling key's identity — project, key id, capabilities, label and the rate-limit budget in force. See [API keys](#api-keys-capabilities-rate-limits-and-the-audit-log) above.               |
| `GET`  | `/api/v1/audit`               | The project's agent-audit trail, newest first (`since` / `until` / `limit`). Needs the ordinary `query` capability. See [API keys](#api-keys-capabilities-rate-limits-and-the-audit-log) above. |

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

### Scene regions (named places)

A proxy says what a scene _looks_ like; **regions** say what its places are
_called_ (ADR 0051 §2). A region is a labelled axis-aligned box inside a scene —
"the entrance", "the checkout counter" — giving humans, dashboards and agents a
shared vocabulary for _where_ things happen, and letting any spatial query be
drilled into a place by name (`?region=entrance`, see above).

```jsonc
{
  "id": "counter", // 1–64 chars of [A-Za-z0-9._:-], unique in the scene
  "label": "Checkout counter", // ≤ 120 chars, shown in dashboards and summaries
  "bounds": [-1, 0, 1, 1, 2, 3], // [minX,minY,minZ,maxX,maxY,maxZ], max ≥ min per axis
  "description": "Where visitors pay.", // optional, ≤ 500 chars
}
```

Regions **may overlap** — a point can be inside several (the enclosing hall and
the counter within it). At most 200 regions per scene. The write **replaces the
scene's whole set**, so removing a region means leaving it out and `[]` clears
them; re-sending the same set is a no-op.

| Method | Path                              | Purpose                                                                                   | Body / params        |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------- | -------------------- |
| `PUT`  | `/api/v1/scenes/:sceneId/regions` | Declare a scene's regions, **replacing** the stored set.                                  | `{ regions: [...] }` |
| `GET`  | `/api/v1/scenes/:sceneId/regions` | A scene's stored regions (with `updatedAt`). An unregistered scene is `[]`, not `404`.    | —                    |
| `GET`  | `/api/v1/scene-regions`           | Every region in the project as `{ sceneId, regionId, label }` — the vocabulary, no boxes. | —                    |

> **Auth.** The two reads take a `query`-capable project API key, like every
> other read. The **write** takes an `annotate`-capable key — the dedicated
> metadata-write capability — so a read-only key you hand to an agent cannot
> redraw your spatial vocabulary. Mint one with
> `uptimizr new-key <projectId> --capabilities annotate`, or
> `--capabilities query,annotate` for a client that both declares regions and
> reads them back; a `query`-only key is refused with `403`.
> `uptimizr regions set` writes straight to the store the collector serves and
> so needs no key at all — it is an operator command, like `new-project`.

From an SDK (`@uptimizr/sdk-core`), next to the proxy scan:

```ts
import { registerRegions } from "@uptimizr/sdk-core";

await registerRegions(
  "lobby",
  [
    { id: "entrance", label: "Entrance", bounds: [-5, 0, -5, 5, 3, 0] },
    { id: "counter", label: "Checkout counter", bounds: [-1, 0, 1, 1, 2, 3] },
  ],
  { endpoint: "https://collect.example.com", apiKey: process.env.UPTIMIZR_ANNOTATE_KEY! },
);
```

The key passed to `registerRegions` needs the `annotate` capability.

> **Never ship the API key in a public bundle.** Event capture is deliberately
> keyless (ADR 0003), but the scene registry — proxy upload and regions alike — is
> an authenticated write. Call `registerRegions` from a build/deploy script, a
> server-side route, an internal admin tool, or a developer-only path. It is a
> one-off authoring step, not a per-page-load call.

Or over HTTP / from the CLI:

```bash
curl -X PUT -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"regions": [{"id": "entrance", "label": "Entrance", "bounds": [-5,0,-5,5,3,0]}]}' \
  "https://collect.example.com/api/v1/scenes/lobby/regions"

# Offline, straight against the store the collector serves:
uptimizr regions set lobby --file regions.json --project "$PROJECT_ID"
uptimizr regions get lobby --project "$PROJECT_ID"
```

`regions.json` is either a bare array of regions or the `{ "regions": [...] }`
envelope the endpoint takes, so one file works with both. `--project` may be
replaced by the `UPTIMIZR_PROJECT_ID` environment variable.

```bash
curl -H "x-api-key: $KEY" \
  "https://collect.example.com/api/v1/perf?session=<session-id>"
```

> Aggregate columns (`count(*)`, percentiles, sums) come back as JSON **numbers**
> from every store. Each store coerces its driver's output at the single point
> rows leave it, and every query route serialises through the metric registry's
> row schema (ADR 0051 §2), so DuckDB, ClickHouse, Postgres and SQL Server return
> the same types — no client-side coercion is needed.
>
> A `null` is not a `0`: a single-row summary is still returned over a range that
> matched no samples, with its aggregate columns `null`. Read that as "no data",
> and check the row's plain count before dividing by it.

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

### Scene retention (`/api/v1/scene-retention`) — canned preset (#147)

A **zero-config** complement to the caller-authored funnel above, aimed at the
"level 1 → level 2 → level 3 retention" case. It is built directly from
`scene_change` markers (ADR 0010) — each marker's envelope `sceneId` is the scene
now active — so a session's ordered scene targets are the levels it moved through
and **no steps need authoring**.

**Semantics** — for each session, its `scene_change` targets are ordered by time;
every **consecutive pair** is a directed link `from_scene → to_scene`. A link's
weight is the number of **distinct sessions** that made that transition, so it
reads as level-to-level retention. A session with a single `scene_change`
contributes no link (there is no "from"). Results are ordered busiest-first and
capped by `limit` (default 100). There is deliberately no `scene` filter — the
value is the cross-scene flow.

```bash
curl -H "x-api-key: $KEY" \
  --get "https://collect.example.com/api/v1/scene-retention" --data-urlencode "limit=50"
# → [{ "from_scene": "lobby", "to_scene": "gallery", "sessions": 128 },
#    { "from_scene": "gallery", "to_scene": "checkout", "sessions": 37 }]
```

From the client:

```ts
const links = await api.sceneRetention({ limit: 50 });
// → [{ from: "lobby", to: "gallery", sessions: 128 }, …]
```

The dashboard renders this as the **Scene retention funnel** panel (grouped
scene → scene bars with drop-off) — a built-in `PanelDefinition` in
`@uptimizr/react`, registered like every other panel (ADR 0036).

---

### Load → bounce funnel (`/api/v1/load-bounce`) — derived (#152)

Slow first loads quietly kill 3D sessions. This endpoint buckets sessions by the
**load time of their initial `asset_load`** (`loadMs`, read from the event payload)
and reports, per band, how many sessions **bounced** — produced no meaningful
interaction (`pointer_*`, `mesh_interaction`, or `camera_gesture`) **at or after**
that load. It is derived entirely from existing events, so there is **no schema
change** and nothing to instrument beyond the standard collector.

Bands are the **upper bounds in milliseconds**, ascending, supplied as a CSV in the
`bands` param; they default to `[1000, 3000, 5000]`, which yields four bands
(`<1s`, `1–3s`, `3–5s`, `≥5s`). Each row is `{ band, sessions, bounced }` where
`band` is the band's lower bound in ms (`0` for the first). Band **labels** are owned
by the client (the dashboard panel), keeping the DB label-free like funnel steps.

```bash
curl -H "x-api-key: $KEY" \
  --get "https://collect.example.com/api/v1/load-bounce" \
  --data-urlencode "bands=1000,3000,5000" --data-urlencode "scene=lobby"
# → [{ "band": 0, "sessions": 90, "bounced": 12 }, { "band": 1000, "sessions": 44, "bounced": 9 }, …]
```

From the client:

```ts
const rows = await api.loadBounce({ bands: [1000, 3000, 5000], scene: "lobby" });
```

The OSS dashboard ships a **Load → bounce funnel** panel that renders these bands
with a bounce-rate bar per band.

---

### Variant leaderboard (`/api/v1/variant-leaderboard`) — configurators (#150)

A **variant → conversion leaderboard** ranks the variants of a 3D product
configurator — colour, material, or trim swaps your scene emits as `custom` events
— by how much attention each gets and how well each converts. A variant is a
`custom` event grouped by its promoted `name` column (the `props`/payload blob is
not a queryable column, so grouping is by name). Like funnels, the collector only
computes the aggregation — it authors nothing.

Per variant the endpoint returns:

| Column         | Meaning                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `variant`      | the custom-event `name` (the variant identifier)                                                                                                                                                       |
| `views`        | total matching events                                                                                                                                                                                  |
| `sessions`     | distinct sessions that viewed it                                                                                                                                                                       |
| `conversions`  | distinct sessions that fired the success event at/after first viewing it (0 without one)                                                                                                               |
| `avg_dwell_ms` | mean dwell from each view to the next boundary — a later _different_ variant view **or** (when configured) a conversion; views with no later boundary are excluded, so `0` means "no measurable dwell" |

Two optional single-predicate params reuse the funnel-step shape (`type` /`name` /
`mesh` equality):

- **`variant`** — selects which events count as variant views. Default
  `{ "type": "custom" }` (every custom event, grouped by name).
- **`conversion`** — the "success" event for the conversion rate. Omit it and
  `conversions` is `0` for every row (views-only).

**Conversion rate** is derived client-side by `CollectorApi.variantLeaderboard` as
`conversions / sessions` (ordered and session-based: the success event must occur at
or after the session first saw the variant). Rows are ranked by `views` (then variant
name); `limit` defaults to 50.

```bash
CONV='{"type":"custom","name":"add_to_cart"}'
curl -H "x-api-key: $KEY" \
  --get "https://collect.example.com/api/v1/variant-leaderboard" \
  --data-urlencode "conversion=$CONV" --data-urlencode "scene=shop"
# → [{ "variant": "red", "views": 128, "sessions": 96, "conversions": 41, "avg_dwell_ms": 5200 }, …]
```

From the client:

```ts
const rows = await api.variantLeaderboard(
  { conversion: { type: "custom", name: "add_to_cart" } },
  { scene: "shop" },
);
// rows[0] → { variant, views, sessions, conversions, avgDwellMs, conversionRate }
```

The dashboard's **Variant → conversion leaderboard** panel loads the ranked variants
with no success event selected, then lets the viewer pick one from an in-panel
dropdown (its options are the discovered variant names) to reveal per-variant
conversion rates — no authoring surface, no schema change.

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
`baseUrl` / `apiKey`, the resolved `params`, raw `filters`, `surface` / `sessionId` (plus the
optional `session` metadata of the inspected session — its recorded scene and camera type — so a
panel such as the walked path can gate on how the session was captured), range-derived
`capabilities`, host `actions` (`selectSession`, `setTimeRange`, `setFilters`, and the optional
`clearTimeRange` that undoes a brush), the realtime `live` layer (`presence`, `enabled`, `status`,
`sceneId`, `subscribe(handler)`), and the resolved per-panel `settings` (see below). A definition
may also set `collapsible` / `defaultCollapsed` for the host chrome.

**Portable panels consume the data seam, not the transport.** All data must flow through
`ctx.api` / `ctx.live` so a host that backs `ctx.api` (e.g. a hosted product that reads
through its own cookie-authed API and leaves `baseUrl` / `apiKey` empty) can reuse every
built-in panel unchanged. `baseUrl` / `apiKey` are a raw escape hatch for bespoke embeds
only — the OSS catalog never reads them (a static test enforces this). Beyond the query
methods, `CollectorApi` exposes two seams for session replay:

- `sessionEvents(sessionId)` → the session's ordered raw events (the replay backfill; hits
  `GET /api/v1/sessions/:id/events`).
- `liveSession(sessionId, handler, options?)` → a subscription-style per-session live tail
  mirroring `ctx.live.subscribe`; returns an unsubscribe function. Each `CollectorApi`
  implementation owns its own connection details (auth, `withCredentials`), so a host tails
  however its transport works.

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
`page.tsx`. Every analytics panel the dashboard shows is a catalog entry; the page itself
mounts only the shell (connection form, filters, scene selector, session inspector, and the
bespoke Session Replay / Live Presence positions).

The portable `ossPanelCatalog` includes the two live surfaces (ADR 0049):
`livePresencePanel` (overview "Live now" roster + event feed) and `sessionReplayPanel`
(the session-surface birdview replay, Babylon-backed and exported directly as
`SessionReplayView` from `@uptimizr/react/panels-3d`). A host that renders a catalog
panel's view itself can pass `PanelHost`'s `exclude` prop to suppress the host-driven
copy. The per-session live-follow hook `useLiveSession` (with `LiveStatus` /
`LiveSessionState`) is exported from `@uptimizr/react` for panels that drive their own tail.

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
