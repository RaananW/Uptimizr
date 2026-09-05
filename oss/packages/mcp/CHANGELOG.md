# @uptimizr/mcp

## 1.0.0

### Major Changes

- 9dd78e8: Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.

### Patch Changes

- Updated dependencies [8194192]
- Updated dependencies [9dd78e8]
- Updated dependencies [6b6a2fe]
  - @uptimizr/agent-core@1.0.0
  - @uptimizr/schema@1.0.0

## 0.2.6

### Patch Changes

- 0af8209: Update runtime dependencies: Fastify 5.12.1 and @fastify/helmet 13.1.1 (collector-server), Next.js 16.3.3 and Babylon.js 9.23.0 (dashboard), and Zod 4.5.4 (schema, agent-core, mcp, replay, collector-server). Dev-only dependency bumps across the remaining packages are not released.
- Updated dependencies [0af8209]
  - @uptimizr/agent-core@0.3.1
  - @uptimizr/schema@0.6.1

## 0.2.5

### Patch Changes

- c84fec4: Resolve three security advisories in transitive runtime dependencies by tightening the
  workspace overrides: `brace-expansion` to `>=5.0.9` (GHSA-rgw5-rvv9-x895, denial of service
  via unbounded intermediate arrays — reached through `@fastify/static`), `fast-uri` to
  `>=3.1.5` (GHSA-7p8r-x3mc-p8w7, host confusion via a backslash authority introducer — reached
  through Fastify and the MCP SDK), and a new `hono` override at `>=4.12.34`
  (GHSA-8j4g-w8fx-2239, regular-expression denial of service in the CORS middleware — reached
  through the MCP SDK). No API or behavior changes.
- Updated dependencies [0e8b8a8]
- Updated dependencies [6d883d0]
- Updated dependencies [8041ca2]
  - @uptimizr/schema@0.6.0

## 0.2.4

### Patch Changes

- 1bb9846: Update the DuckDB and Model Context Protocol runtime dependencies to their latest compatible releases.

## 0.2.3

### Patch Changes

- Updated dependencies [dd34af8]
  - @uptimizr/agent-core@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [d12c2f4]
- Updated dependencies [ae5bcd9]
- Updated dependencies [8ec1cdb]
  - @uptimizr/agent-core@0.2.2

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
