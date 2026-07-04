---
"@uptimizr/react": patch
"@uptimizr/dashboard": patch
---

fix(react,dashboard): stop 3D panels re-rendering and resetting the camera on every data refresh

The Babylon 3D analytics panels rebuilt their entire engine/scene on every
data update, which flickered ("Rendering…") and snapped the user's orbit
camera back to its default framing several times per second on the live
demo/session views. Each view now initializes the scene **once** and repaints
only the data-driven content in place — the camera is framed a single time at
build and is never reset by a live refresh.

- @uptimizr/react: split the single data-keyed effect in every 3D view
  (`WorldHeatmap3D`, `CameraDome3D`, `ClickRays3D`, `GazeClickDivergence3D`,
  `FlowSankey3D`) into a lifecycle effect (engine/scene/camera/lights, framed
  once) plus an in-place data-sync effect that repaints thin-instance buffers /
  content meshes without touching the camera. Latest data is read through refs;
  the faint proxy backdrop is rebuilt only when the scene geometry actually
  changes.
- @uptimizr/react: fix `MeshUvHeatmap` (2D) flicker — keep the last rendered
  canvas on screen during a background refetch instead of swapping in a
  "Loading…" placeholder every refresh.
- @uptimizr/dashboard: refresh live-session panels while a session drill-down is
  open so their data updates in real time instead of only after navigating away
  and back.
