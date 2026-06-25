---
"@uptimizr/replay": minor
---

feat(replay): load a `.glb` backdrop and re-drive a session over it (#80)

Add a Babylon-only scene-backdrop loader so replay can bring its own scene when the host has none
(e.g. a hosted drag-and-drop viewer). Exposed two ways: a standalone
`loadSceneBackdrop(scene, source, options?)` from `@uptimizr/replay/babylon` (accepts a URL or a
dropped `File`, returns a disposable `{ rootNodes, meshes, container, dispose() }` handle), and a
`backdropUrl` option on the global `replayInScene`. The npm helper lazily imports Babylon's glTF
`SceneLoader`, and the global path reuses the host page's loader, so neither the lean driver path
nor the IIFE build bundles a second copy of the loader. Loaded actor/subtree nodes re-drive exactly
like any other scene node (`node_transform`, ADR 0033).
