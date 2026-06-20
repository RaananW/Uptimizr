# @uptimizr/aframe

The [A-Frame](https://aframe.io) (WebXR) connector for Uptimizr.

A-Frame renders **three.js** under the hood — `sceneEl.object3D` is the `THREE.Scene`,
`sceneEl.camera` the active `THREE.Camera`, and `sceneEl.renderer` the
`THREE.WebGLRenderer`. So this package is a **thin A-Frame layer over
[`@uptimizr/three`](../sdk-three)** — it does _not_ re-implement capture. A declarative
component grabs those three objects and hands them to the three connector, which
captures:

- **camera pose** (position + forward direction) → view-direction heatmap
- **pointer move / click** (normalized screen + optional raycast hit) → screen heatmaps
- **mesh picks** → object-engagement analytics
- **FPS** → performance
- **mesh visibility / hover dwell / resource sample** (opt-in) → attention & footprint

`three` is a **peer dependency**; **A-Frame itself is supplied by the host page** (the
connector never imports `aframe` — it registers against the global `AFRAME` and reads
the host page's three.js instances, so it bundles neither). Capture starts when the
component initializes and stops on teardown, tearing down every listener, timer, and
animation-frame callback (no cookies, no persistent ids).

World-space data is normalized to the canonical wire frame by `@uptimizr/three`;
sessions are attributed to the **`aframe`** connector while keeping three's native
right-handed coordinate frame.

## Install

```bash
npm install @uptimizr/aframe three
```

`three` is a **peer dependency**. **A-Frame itself is supplied by the host page**
(load it from the official CDN or your own bundle) — see the note at the end of
this README on why `aframe` is not an npm dependency.

## Usage

Load A-Frame, then import this package (it registers the `uptimizr` component), and add
the attribute to your `<a-scene>`:

```html
<head>
  <script src="https://aframe.io/releases/1.7.0/aframe.min.js"></script>
  <script type="module">
    import "@uptimizr/aframe";
  </script>
</head>
<body>
  <a-scene uptimizr="projectId: your-project; collector: https://collect.example.com">
    <a-box position="0 1 -3" color="#4db4e6"></a-box>
    <a-sky color="#0b0e14"></a-sky>
  </a-scene>
</body>
```

A bare `import "@uptimizr/aframe"` is enough — the entry point registers the component
against the global `AFRAME`. (To register against an explicit instance, call
`registerUptimizrComponent(AFRAME)`.)

## WebXR — the differentiator

A-Frame is WebXR-first, so the connector adds the one thing the three.js desktop path
does not: it maps **XR input** onto the existing source-neutral schema events
with **no new event types or fields**:

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

The head/headset pose is already captured as `camera_sample` by `@uptimizr/three` (in
XR, three's active camera is the headset). XR capture is on by default; disable it with
`uptimizr="...; xr: false"`. In-scene XR hits (`hitPoint`/`hitMesh` and
`mesh_interaction`) require a ray raycast probe — see `xrCollector`'s `raycast` option;
without one, controller/gaze rays and `pointer_click` are still captured. The only id
emitted is the ephemeral, session-local `handedness` disambiguator — never a persistent
device/user id.

## Options

The component schema maps onto the three connector's
[`TrackSceneOptions`](../sdk-three/src/trackScene.ts):

| Attribute                                          | Meaning                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| `projectId`                                        | Project identifier (public, non-secret)        |
| `collector`                                        | Collector endpoint base URL                    |
| `sampleCameraMs` / `samplePerfMs`                  | Sampling intervals (`0` ⇒ connector default)   |
| `pointerMoveThrottleMs`                            | Pointer-move throttle (`0` ⇒ default)          |
| `sceneDescription`                                 | Free-text scene label                          |
| `meshVisibility` / `hoverDwell` / `resourceSample` | Opt-in capture channels (off by default)       |
| `xr`                                               | WebXR controller/gaze capture (default `true`) |
| `xrSampleMs`                                       | XR pose sampling interval (`0` ⇒ 250 ms)       |
| `disabled`                                         | Collect nothing                                |
| `debug`                                            | Console debug logs                             |

## Replay

A-Frame sessions replay through the existing [`@uptimizr/replay`](../replay) **three**
driver — the captured payload is three.js data, only the connector _name_ differs.
Replay drivers are selected by the host's engine, not by connector name, so no
A-Frame-specific driver is needed.

## Boundary

Depends only on `@uptimizr/three`, `@uptimizr/sdk-core`, and `@uptimizr/schema`.
`@uptimizr/three` is the one
connector dependency this package has — by design, since A-Frame _is_ three.js.

`aframe` is intentionally **not** declared as an npm (peer) dependency: the connector
is fully structural (it never imports `aframe`), and A-Frame's published package pulls a
git-resolved subdependency (`three-bmfont-text`) that the repo's supply-chain policy
blocks. The host page provides A-Frame — load it from the official CDN or your own
bundle.

## License

[Apache-2.0](./LICENSE) © Uptimizr.
