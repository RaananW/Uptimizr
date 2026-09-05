---
title: A-Frame
description: Instrument an A-Frame (WebXR) scene with the @uptimizr/aframe connector.
---

The A-Frame (WebXR) connector. A-Frame renders three.js under the hood, so this package is a thin
A-Frame layer over [`@uptimizr/three`](/docs/connectors/three/) — it does not re-implement capture.
A declarative component reads `sceneEl.object3D`, `sceneEl.camera`, and `sceneEl.renderer` and hands
them to the three connector.

`three` is a peer dependency; **A-Frame itself is supplied by the host page** (the connector never
imports `aframe` — it registers against the global `AFRAME`).

## Install

```bash
npm install @uptimizr/aframe three
```

## Usage

Load A-Frame, import this package (it registers the `uptimizr` component), and add the attribute to
your `<a-scene>`:

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

A bare `import "@uptimizr/aframe"` is enough — the entry point registers the component against the
global `AFRAME`. To register against an explicit instance, call `registerUptimizrComponent(AFRAME)`.

Capture starts when the component initializes and stops on teardown, tearing down every listener,
timer, and animation-frame callback — no cookies, no persistent IDs. World-space data is normalized
to the canonical wire frame by `@uptimizr/three`; the session is attributed to the `aframe`
connector.

## WebXR input

A-Frame is WebXR-first, so the connector maps XR input onto the existing source-neutral events
with no new event types: controller/gaze **pose** → `pointer_move` with a world-space `ray` and
`source` (`xr-controller`, `hand`, `gaze`, `transient`), **select** → `pointer_click` (+
`mesh_interaction` `kind: select`), **squeeze** → `mesh_interaction` `kind: squeeze`. The headset
pose keeps flowing as `camera_sample`.

In-scene hit resolution is on by default: the component builds a raycast probe over the live
three.js scene graph, so ray samples carry `hitPoint`/`hitMesh` and select/squeeze attach to the
object actually hit. Name your entities' meshes (`object3D.name`) to make `hitMesh` meaningful.

| Attribute    | Meaning                                           |
| ------------ | ------------------------------------------------- |
| `xr`         | WebXR controller/gaze capture (default `true`)    |
| `xrSampleMs` | XR pose sampling interval in ms (`0` ⇒ 250)       |
| `xrRaycast`  | Resolve XR rays to in-scene hits (default `true`) |

```html
<a-scene
  uptimizr="projectId: your-project; collector: https://collect.example.com; xrRaycast: false"
></a-scene>
```
