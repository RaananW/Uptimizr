---
"@uptimizr/react": minor
"@uptimizr/dashboard": minor
---

feat(dashboard): runtime/remote panel loading (#61)

The dashboard can now discover and load panels from a remote manifest at runtime — behind the same
`PanelDefinition` contract — so self-hosters add panels without rebuilding. `@uptimizr/react` gains
`PANEL_CONTRACT_VERSION` and a framework-agnostic loader (`fetchPanelManifest`, `loadRemotePanels`,
`mergePanels`, plus manifest/definition guards) with contract-version gating, an optional origin
allowlist, and per-entry error isolation. The dashboard reads `NEXT_PUBLIC_PANELS_MANIFEST_URL`
(and optional `NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS`), merges remote panels with the built-ins,
surfaces load failures in a banner, and hardens `PanelHost` with a guarded `enabled()` and a
per-panel render error boundary so a misbehaving panel never breaks the grid. Off by default;
build-time registration is unchanged.
