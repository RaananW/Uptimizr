---
"@uptimizr/react": minor
"@uptimizr/dashboard": minor
---

feat(dashboard): viewer-configurable panels — hide/show with restore plus typed per-panel settings (#79)

Panels can now be hidden and restored (always reversible, viewer-local) and expose typed settings
(`number`/`boolean`/`select`) via a generic `PanelDefinition`/`PanelContext` contract. Settings are
resolved with declared defaults overlaid by saved overrides through a swappable `PanelStateStore`
seam, and `usePanelData` refetches on settings change. Built-in data-resolution settings ship for
the floor-plan, view-direction dome, world/voxel heatmap, pointer heatmap, click flow, and top-meshes
panels.
