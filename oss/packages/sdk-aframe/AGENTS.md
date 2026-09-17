# AGENTS.md — @uptimizr/aframe

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The [A-Frame](https://aframe.io) (WebXR) connector for Uptimizr.

A-Frame renders **three.js** under the hood — `sceneEl.object3D` is the `THREE.Scene`,
`sceneEl.camera` the active `THREE.Camera`, `sceneEl.renderer` the `THREE.WebGLRenderer` — so this
package is a **thin A-Frame layer over `@uptimizr/three`**. It does not re-implement capture,
raycasting or coordinate canonicalization. The integration surface is a declarative component:
`<a-scene uptimizr="projectId: …; collector: …">`.

The one place A-Frame does **more** than wrap three is WebXR: `xrCollector` (authored in
`@uptimizr/three`, re-exported here) maps XR controller/gaze pose and select/squeeze actions onto
the existing source-neutral schema events — **no new event types or fields** (ADR 0011).

`three` is a **peer dependency**. `aframe` is intentionally **not** an npm (peer) dependency: the
connector is fully structural (it never imports `aframe`), it registers against the global
`AFRAME`, and A-Frame's published package pulls a git-resolved subdependency the repo's
supply-chain policy blocks. The host page supplies A-Frame.

Sessions are attributed to the **`aframe`** connector (`connector.name === "aframe"`) while keeping
three's native right-handed frame; world-space data is normalized by `@uptimizr/three` (ADR 0018).

## Install

```bash
pnpm add @uptimizr/aframe
# `three` is a peer dependency; load A-Frame itself from the CDN or your own bundle.
```

## Canonical usage

Load A-Frame, then import this package (a bare import registers the `uptimizr` component against
the global `AFRAME`), and add the attribute to your `<a-scene>`:

```html
<script src="https://aframe.io/releases/1.7.0/aframe.min.js"></script>
<script type="module">
  import "@uptimizr/aframe";
</script>
<a-scene uptimizr="projectId: your-project; collector: https://collect.example.com">
  <a-box position="0 1 -3"></a-box>
</a-scene>
```

To register against an explicit instance instead, call `registerUptimizrComponent(AFRAME)`.
Capture starts when the component initializes and stops on teardown, tearing down every listener,
timer and rAF callback — there is no separate `dispose()`.

The component instance (`UptimizrComponentInstance`) holds the live `@uptimizr/sdk-core`
`UptimizrClient` on `_uptimizrClient`. For runtime calls — `client.track(name, props)` for custom
events, `client.setScene(sceneId)` when moving between areas (ADR 0010) — prefer a programmatic
host using the three connector's `trackScene` directly; the declarative `sceneId` attribute covers
the static case.

## Component schema

`projectId`, `collector`, `sampleCameraMs` / `samplePerfMs` / `pointerMoveThrottleMs` (`0` ⇒
connector default), `sceneDescription`, `sceneId`, `cameraType`, the opt-in `meshVisibility` /
`hoverDwell` / `resourceSample` / `gaze` channels, `cameraGesture` (default `true`), `xr`
(default `true`), `xrSampleMs` (`0` ⇒ 250 ms), `xrRaycast` (default `true`), `disabled`, `debug`.

`buildTrackOptions(data)` maps that schema onto the three connector's `TrackSceneOptions`;
`UPTIMIZR_SCHEMA` and `COMPONENT_NAME` are the declared schema and the attribute name.

## WebXR

| XR signal                              | Emitted as                                           |
| -------------------------------------- | ---------------------------------------------------- |
| Controller / gaze **pose** (per frame) | `pointer_move` with a world-space `ray` + `source`   |
| Controller **handedness**              | `handedness: "left" \| "right"` (+ `sourceId`)       |
| Tracked controller                     | `source: "xr-controller"`                            |
| Articulated hand                       | `source: "hand"`                                     |
| Gaze target-ray                        | `source: "gaze"`                                     |
| Transient / screen tap                 | `source: "transient"`                                |
| **select** (trigger)                   | `pointer_click` (+ `mesh_interaction` `kind:select`) |
| **squeeze** (grip)                     | `mesh_interaction` `kind:squeeze`                    |

The headset's own pose already flows through the regular `camera_sample` channel (in XR, three's
active camera is the headset). In-scene XR hits are resolved by default with three's raycaster
(`createXrRaycaster`); set `xrRaycast: false` to capture rays and `pointer_click` only.

## Rules for agents

- **Never re-implement capture here.** Anything about what is captured, sampled or normalized is a
  change to `@uptimizr/three`; this package only bridges the A-Frame component to it.
- Depend only on `@uptimizr/three`, `@uptimizr/sdk-core` and `@uptimizr/schema`. Do **not** add
  `aframe` as a dependency — read the global `AFRAME` structurally.
- Emit only `@uptimizr/schema` events; XR input maps onto the **existing** source-neutral events
  (ADR 0011) — never add an XR-specific event type or field.
- Privacy (ADR 0003): no cookies, no persistent client identifier. The only id emitted for XR is
  the ephemeral, session-local `handedness` / `sourceId` disambiguator — **never** a persistent
  device or user id. Attention channels are off by default; keep them opt-in.
- `registerRegions(sceneId, regions, { endpoint, apiKey })` (from `@uptimizr/sdk-core`) declares a
  scene's named regions. It **replaces** the scene's set and needs an **`annotate`**-capable key —
  never ship that key in a public bundle; call it from build/deploy/admin code.
- A-Frame sessions replay through `@uptimizr/replay`'s existing **three** driver — drivers are
  selected by the host's engine, not by connector name.

## More

- Package reference: [README.md](./README.md)
- Connector guide: https://uptimizr.com/docs/connectors/aframe/
- three connector guide: [`@uptimizr/three`](../sdk-three/AGENTS.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
