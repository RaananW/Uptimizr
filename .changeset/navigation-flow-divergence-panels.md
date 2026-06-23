---
"@uptimizr/react": minor
"@uptimizr/dashboard": patch
---

feat: add three more built-in dashboard panels via the ADR 0036 panel contract.

- **Navigation-style mix** (`navigation-mix`, #69): a half-width breakdown of camera-gesture
  kinds (orbit / pan / dolly / zoom / roll / fly) with per-kind share and average gesture
  duration. Backed by a new `CollectorApi.cameraGestures()` client method on `@uptimizr/react`
  over the existing `/api/v1/camera-gestures` endpoint.
- **Flow Sankey (3D)** (`flow-sankey-3d`, #68): the direction-bin → mesh (and standpoint → gaze
  → mesh) flow renderer is now a full-width, client-only `PanelDefinition`; the panel owns its
  walk/orbit/all camera-mode toggle, so the base query drops the global camera-mode filter.
- **Gaze vs. click divergence** (`gaze-click-divergence-3d`, #70): a full-width, client-only
  overlay of world-space gaze voxels (cool) against click voxels (warm) at a shared cell size,
  with overlay / gaze / click / divergence view modes.
