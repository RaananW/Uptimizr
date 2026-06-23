---
"@uptimizr/dashboard": patch
---

feat(dashboard): register the floor-plan dwell heatmap as a built-in panel (ADR 0036). The top-down camera-position heatmap is now a reusable `PanelDefinition` in `builtinPanels`, so embedders of `@uptimizr/react` get it too. It stays hidden in the orbit/"viewer" camera mode and renders on both the overview and session surfaces.
