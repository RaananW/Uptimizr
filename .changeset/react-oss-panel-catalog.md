---
"@uptimizr/react": minor
---

feat(react): make `@uptimizr/react` the single source of truth for the OSS
dashboard's analytics panels (ADR 0047, serving the downstream consumer's
ADR 0052). The package now exports `ossPanelCatalog` — the complete, portable
set of built-in panels — so a downstream host can enumerate and render the
entire OSS panel catalog from the package alone. Every catalog panel is also
exported individually (`topMeshesPanel`, `worldHeatmapPanel`, `flowPanel`, …),
along with the panel view components (`TopMeshesView`, `FloorPlanHeatmapView`,
…) and their 3D/canvas helper libs (`mergeSceneProxies`, `disableWheelZoom`,
`attachMeshHover`, `buildTwoStageGraph`, …).

Babylon.js stays optional: `@babylonjs/core` is an **optional** peer dependency,
and the Babylon-backed 3D panels keep their view code behind `React.lazy` inside
the catalog, so importing `ossPanelCatalog` never loads `@babylonjs/*` at
module-eval time. The core entry stays `sideEffects: false` and Babylon-free. A
new `@uptimizr/react/panels-3d` subpath exposes the 3D view components for
direct, opt-in composition outside the catalog.

Additive and non-breaking — every existing export keeps working and the panel
contract version is unchanged. The standalone dashboard is refactored to a thin
consumer of `ossPanelCatalog`.
