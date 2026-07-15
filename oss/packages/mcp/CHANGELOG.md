# @uptimizr/mcp

## 0.2.1

### Patch Changes

- Updated dependencies [b18c955]
  - @uptimizr/agent-core@0.2.1

## 0.2.0

### Minor Changes

- aaf0ea7: feat(mcp): add capability resources, curated prompts, and new read tools

  Evolve the read-only MCP server per ADR 0050 §7:

  - **Resources** for self-discovery: `uptimizr://capabilities` (a machine-readable descriptor of
    event types, the tool catalog, and parameter semantics, sourced from the shared catalog +
    `@uptimizr/schema`) and `uptimizr://scenes` (the live scene ids for the `scene` parameter).
  - **Prompts**: curated templates `weekly_scene_health`, `attention_hotspots`, and
    `xr_comfort_review` that drive the existing tools.
  - **New tools** surfaced from the shared catalog: funnels, aggregate desire-line paths,
    rendering-technology breakdown, and XR spatial analytics.

  The server remains strictly read-only (ADR 0003 / ADR 0017). A Streamable HTTP transport stays
  deferred as a separate, auth-gated follow-up.

### Patch Changes

- 3d04ee0: docs: clarify how to run the MCP server via `npx`, add a GitHub Copilot CLI config example, and
  document that the server connects only to the collector's HTTP query API (never the database
  directly), keeping the collector the single gateway to the store.
- f3ca500: refactor(mcp): source the read-only tool catalog and collector client from the new
  `@uptimizr/agent-core` package instead of defining them locally, so the tool surface is defined
  once and can't drift from the dashboard/demo assistants (ADR 0050). Public API and MCP runtime
  behavior are unchanged — the catalog and client are re-exported.
- 59fd29b: docs: refresh package and app READMEs to match current source

  Reconcile every package/app README with the actual code — corrected package/connector
  lists, public APIs and options, CLI flags, env vars, ports, the event catalog, and
  cross-links. Also drop "Google Analytics" references in favor of neutral "web analytics"
  wording. Documentation-only; no runtime behavior changes.

- Updated dependencies [dd6e3f8]
- Updated dependencies [36f78e8]
- Updated dependencies [f3ca500]
- Updated dependencies [aaf0ea7]
- Updated dependencies [59fd29b]
  - @uptimizr/agent-core@0.2.0
  - @uptimizr/schema@0.5.1

## 0.1.1

### Patch Changes

- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.

## 0.1.0

### Minor Changes

- b2b7b44: Initial public release of Uptimizr — open-source, privacy-first analytics for 3D scenes.

  This first `0.1.0` ships the full open-source data collector: the `@uptimizr/schema` event
  contracts, the `@uptimizr/sdk-core` runtime, engine connectors (`@uptimizr/babylon`,
  `@uptimizr/babylon-lite`, `@uptimizr/three`, `@uptimizr/r3f`, `@uptimizr/aframe`,
  `@uptimizr/playcanvas`, `@uptimizr/react`), session `@uptimizr/replay`, the `@uptimizr/heatmap`
  renderer, the embedded-store `@uptimizr/db` layer, the `@uptimizr/mcp` server, and the
  `@uptimizr/collector-server` ingestion/query API plus the `@uptimizr/dashboard`.
