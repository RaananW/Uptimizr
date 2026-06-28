# ADR 0045: Web-export engine connectors (Unity, Godot, Unreal)

- **Status:** Proposed
- **Date:** 2026-06-28
- **Deciders:** Project owner, engineering

## Context

Every connector Uptimizr ships today (`@uptimizr/babylon`, plus the three.js / PlayCanvas / R3F /
A-Frame adapters) works the same way: the engine is a **JavaScript library running in the page**,
so the connector reads a **live JS scene object by duck typing** (the engine is a _type-only peer
dependency_ — see `add-connector` and ADR 0018). Camera pose, picks, named meshes, and FPS are all
read passively off objects the host already created. The whole SDK (`@uptimizr/sdk-core`) is
browser-TypeScript: transport (`navigator.sendBeacon` / `fetch`), batching, session/visitor model,
and lifecycle hooks.

Unity, Godot, and Unreal are **native engines**. Their applications are authored in C# (Unity),
GDScript/C# (Godot), or C++ (Unreal), and ship as native desktop / mobile / console binaries. There
is no JavaScript runtime and no JS scene object to read. This breaks the connector model in two
distinct ways depending on the target:

1. **Native builds (desktop/mobile/console).** No browser, no JS, none of `sdk-core` can run. The
   only reusable assets are the **wire contract** (`@uptimizr/schema` is effectively the spec) and
   the **collector server** (unchanged). Supporting these means re-implementing the entire client —
   session/visitor IDs, queue/batching, an HTTP transport, and per-engine capture — natively in
   C#/GDScript/C++, once per engine.
2. **Web exports.** Unity (WebGL), Godot (Web/HTML5), and historically Unreal (Emscripten HTML5)
   compile the engine to **WebAssembly** and render into a `<canvas>`. The page _is_ a browser
   context, so `sdk-core` can run unchanged — but the **scene graph lives in WASM linear memory**.
   JS cannot duck-type a Unity `Camera` or a Godot `Node3D`; there is no stable ABI to read engine
   memory from JS. So a connector cannot capture pose/picks **passively** the way the Babylon
   adapter does.

We want first-class support for Unity, Godot, and (if technically viable) Unreal without forking
`sdk-core`, re-implementing the collector contract, or redefining events.

## Decision

**Support Unity, Godot, and Unreal through their web exports** using a **two-part connector**, and
treat all three as a single effort sharing one architecture (not a staged rollout). Native
(non-web) builds are **explicitly out of scope** for the OSS collector — they would require a
ground-up native SDK and are not connector-shaped.

Each engine gets one package — `@uptimizr/unity`, `@uptimizr/godot`, `@uptimizr/unreal` — and each
package has two halves:

### 1. A browser-side JS connector (registers as an `sdk-core` collector)

Runs in the export's host page exactly like the Babylon adapter: `client.use(<engine>Collector())`.
It owns **all** schema mapping, coordinate normalization, sampling, and emission. The engine never
emits a schema event directly — keeping "events live once" (`@uptimizr/schema`) and the
canonical-frame normalization (ADR 0018) in **one** place, in TypeScript.

### 2. A thin engine-side bridge (ships as a copy-in asset, not an npm package)

A small, dumb shim authored in the engine's language that **pushes per-sample telemetry across the
JS interop boundary** to the connector. It carries no analytics logic, no IDs, no schema knowledge —
it reads the engine's own camera/raycast/perf and calls a tiny, versioned JS API:

- **Unity** — a `.jslib` plugin (Emscripten) exposing functions the C# side invokes via
  `[DllImport("__Internal")]`, driven by a small `MonoBehaviour`.
- **Godot 4** — `JavaScriptBridge` (`JavaScriptBridge.get_interface(...)` / `eval`) called from a
  GDScript or C# autoload.
- **Unreal** — an Emscripten `EM_JS` / `cwrap` shim from the C++ web target. **Feasibility caveat:**
  Epic deprecated the official HTML5/Emscripten target after UE 4.24, and Pixel Streaming is
  server-side rendering (no client WASM scene to read), so it does **not** fit this model. Unreal is
  therefore **best-effort, pending a viable WASM/web toolchain** (community HTML5 fork or a future
  official target); the package and bridge contract are defined now so it drops in if/when a target
  exists.

### 3. Two tiers of capture — what is free vs. what needs the bridge

| Capability | Source | Engine bridge needed? |
| --- | --- | --- |
| Pointer move/click heatmaps (screen-space), FPS (rAF timing), lifecycle, custom events, error capture | the `<canvas>` DOM + `requestAnimationFrame`, purely in JS | **No** — zero engine code |
| Camera pose / view-direction heatmap, world-space gaze, raycast picks, mesh interaction, scene proxy, node transforms, replay-completeness | engine-side camera/raycast/scene, pushed over the bridge | **Yes** |

The JS-only tier gives a meaningful zero-config result on any web export (heatmaps + perf +
custom); the 3D-native value (pose, world-space, replay) layers on once the bridge is added.

### 4. Bridge data contract

The JS-facing API the engine calls is **minimal, versioned, and stable** — e.g.
`pushPose(worldPos, worldForward, worldUp, fov)`, `pushPick(objectName, worldHitPoint)`,
`pushPerf(fps, longFrames)`, `setSceneProxy(nodes)`. All values are **world-space in the engine's
native frame**; the JS connector normalizes to the canonical wire frame. Keeping the surface tiny
makes the per-engine shims trivial and isolates churn to TypeScript.

### 5. Coordinate frames & connector provenance (ADR 0018)

No schema change is required: `connector.name` is a free string, and `coordinateSystem` already
encodes `handedness`, `upAxis` (`y`/`z`), and `unitScale`. Each connector records its engine's
**native** frame as provenance on `session_start` and normalizes world-space payloads at the
emission boundary:

| Engine | Native frame | Normalization to canonical (LH, y-up, unit 1) |
| --- | --- | --- |
| **Unity** | left-handed, **y-up**, meters | already canonical — no axis conversion |
| **Godot** | right-handed, **y-up**, meters | negate Z (`toCanonicalPosition`/`Direction`/`Aabb`/`Quat`) |
| **Unreal** | left-handed, **z-up**, **centimeters** | rebase z-up → y-up **and** apply `unitScale` (cm→m); record both in provenance |

Unreal is the one that exercises the non-`y` `upAxis` and non-1 `unitScale` paths; the connector
must rebase to y-up **before** calling the shared helpers (which assume a y-up source).

### 6. Privacy (ADR 0003)

The bridge transmits only low-cardinality, non-PII telemetry: poses, FPS, and developer-assigned
**named** objects. No client persistent IDs are created engine-side; the server-side daily-rotating
visitor hash is unchanged. Engine shims MUST NOT invent identifiers or forward raw input text.

## Consequences

### Positive

- **Reuses the entire OSS stack unchanged** — `sdk-core`, the collector server, `@uptimizr/schema`,
  and `@uptimizr/replay` all work as-is; only a per-engine JS connector + a thin shim are new.
- **One normalization point.** Schema mapping and canonical-frame conversion stay in TypeScript, so
  "events live once" and ADR 0018 hold across every engine.
- **Tiered value.** Web exports get pointer heatmaps + perf + custom events with **no engine code**;
  pose/world-space/replay layer on with the bridge.
- **No schema change.** Existing `connector` provenance (handedness / upAxis / unitScale) already
  describes Unity, Godot, and Unreal frames.

### Negative / trade-offs

- **Not drop-in.** Unlike the Babylon adapter, the host must add engine-side code (a `.jslib` + C#
  component, a GDScript autoload, or an Emscripten shim) to get the 3D-native channels.
- **Per-engine bridge maintenance** across engine/toolchain versions, in three languages.
- **Native (non-web) builds remain unsupported** — desktop/mobile/console need a separate native
  SDK that is out of scope here.
- **Unreal is uncertain.** Without an official WASM/HTML5 target, the Unreal connector is best-effort
  and may ship only the JS-only tier (or remain unreleased) until a toolchain exists.
- **Reduced auto-detection.** Device/GPU/graphics introspection is thinner than Babylon's, since the
  WASM scene and engine internals are not readable from JS — those fields stay best-effort.

## Alternatives considered

- **Full native SDK per engine** (re-implement `sdk-core` in C# / GDScript / C++). Rejected:
  massive duplication of transport/batching/session, three diverging copies of the wire logic away
  from the TS source of truth, and not connector-shaped. The wire contract is documented, so a
  native SDK remains possible later as a separate product, but it is not this decision.
- **JS-only, no engine bridge, as the whole solution.** Rejected as the complete answer: it cannot
  recover camera pose, world-space hits, or replay — the core 3D-analytics value. Retained instead
  as the **zero-config tier** inside each bridged connector.
- **Read the WASM heap from JS directly.** Rejected: engine memory layout is build/version-specific
  with no stable ABI; fragile, unsafe, and would break on every engine update.
- **Defer Unreal entirely.** Considered. We instead keep Unreal **in scope as best-effort** and
  define its bridge contract now, so it lands cleanly if a viable web target appears — while being
  honest in docs that it may not ship initially.
