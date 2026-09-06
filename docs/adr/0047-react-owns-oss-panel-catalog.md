# ADR 0047: `@uptimizr/react` owns the portable OSS panel catalog

- **Status:** Accepted (partially revised by ADR 0049 — Session Replay and Live
  Presence moved into the catalog). _2026-09: fully realized — the last
  hand-mounted dashboard panels (event volume, scene health, engine diagnostics,
  rendering technology, scene traversal, perf summary + the ADR 0028 detail
  panels, input sources, the 2D view-direction disc, the 3D gaze heatmap and
  click rays, the sessions table, and the walked path) moved into the catalog.
  The dashboard mounts nothing analytics-shaped outside `PanelHost` except the
  session inspector and the bespoke Session Replay / Live Presence positions._
- **Date:** 2025-02-14
- **Deciders:** Dashboard / SDK maintainers

## Context

The OSS analytics panels were split across two places. `@uptimizr/react`
published the panel _contract_ (ADR 0036), the `CollectorApi` client, filters,
canvas primitives, and four panels (Sessions, PointerHeatmap,
ViewDirectionHeatmap, PerformanceSummary). But the other ~15 dashboard panels —
their view components, 3D/canvas helper libs, and the `definePanel` catalog —
lived privately inside `oss/apps/dashboard` and were not consumable.

A downstream hosted product consumes `@uptimizr/react` and must mirror the
**full** OSS panel catalog automatically and ungated (that product's own
ADR 0052). It cannot do so while most panels are trapped in the app. The package
needs to be the single source of truth for the panel set, so the whole OSS panel
catalog can be recreated from the package alone.

The tension: `@uptimizr/react` has **no** runtime Babylon dependency and is
`sideEffects: false` (tree-shakeable). Several 3D panels are Babylon-backed.
Moving them into the package must not force `@babylonjs/*` onto every consumer.

## Decision

Move the complete panel set into `@uptimizr/react` and export it as one portable
catalog:

- **`ossPanelCatalog: PanelDefinition[]`** — every OSS panel, in dashboard order.
  Each panel is also exported individually (`topMeshesPanel`, `worldHeatmapPanel`,
  …) for cherry-picking. The panel view components and the 3D/canvas helper libs
  (`mergeSceneProxies`, `orbitZoom`, `sceneHover`, `flowGraph`) are exported too.
- **Babylon stays optional and code-split.** `@babylonjs/core` is an _optional_
  peer dependency (`peerDependenciesMeta.optional`) plus a devDependency for
  building/testing. The catalog keeps its 3D panel views behind `React.lazy`, so
  the catalog module's static import graph never references the 3D view modules —
  importing `ossPanelCatalog` never loads `@babylonjs/*` at module-eval time.
  Babylon's chunk is fetched only when a 3D panel actually renders. The core
  entry stays Babylon-free and `sideEffects: false`.
- **`@uptimizr/react/panels-3d` subpath** exposes the Babylon-backed view
  components directly, for hosts that compose a 3D view _outside_ the catalog
  (e.g. the dashboard's bespoke gaze-heatmap and click-rays mounts). It is the
  only entry that pulls the 3D view modules into a consumer's graph.
- The standalone dashboard becomes a **thin consumer**: its panel registry just
  re-exports `ossPanelCatalog`. The app keeps only the dashboard _shell_ (global
  filters, scene selector, session inspector/replay, live SSE wiring, layout,
  remote-panel loading). The package owns _panels_; the app owns the _dashboard_.

This is additive and non-breaking: every prior export keeps working and the
panel contract version (`PANEL_CONTRACT_VERSION`) is unchanged.

## Consequences

### Positive

- A downstream consumer can enumerate and render the entire OSS panel catalog
  from the package alone (satisfies the consumer's ADR 0052).
- One implementation of each panel — no fork between the dashboard and embedders.
- Consumers pay zero Babylon cost unless they render a 3D panel; the core bundle
  stays Babylon-free and tree-shakeable.

### Negative / trade-offs

- Hosts that render the catalog panels must point Tailwind at the package source
  (Tailwind v4 skips `node_modules`), or the panel utility classes are tree-shaken
  out and panels render unstyled. Documented in the package README; the dashboard
  adds an `@source` directive.
- Two ways to reach a 3D view (lazy via the catalog, or the `panels-3d` subpath).
  The subpath is documented as opt-in for direct composition only. (Since the
  gaze heatmap and click rays joined the catalog, the dashboard itself uses the
  subpath only for Session Replay.)

## Alternatives considered

- **Make `@babylonjs/core` a hard dependency.** Rejected — it would force Babylon
  (a large dependency) onto every consumer, including those rendering only 2D
  panels, and break the Babylon-free, tree-shakeable core.
- **Keep the catalog in the app and publish only the contract.** Rejected — the
  downstream product could not mirror the full catalog, which is the whole point.
- **A second package (e.g. `@uptimizr/react-3d`).** Rejected for now — a subpath
  export keeps one package and one catalog while still isolating Babylon; a split
  package can supersede this if the 3D surface grows independently.
