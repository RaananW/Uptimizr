# @uptimizr/schema

## 0.2.0

### Minor Changes

- 9e22ebd: feat: caller-configured conversion-funnel aggregation (#78).

  Implements sub-issue (b) of the funnel epic in OSS. Authoring, persistence, and the
  saved-funnel dashboard panel remain hosted-only — the OSS dashboard stays a passive
  viewer (ADR 0038).

  - `@uptimizr/schema`: shared funnel contract — `funnelStepSchema`, `funnelStepsSchema`
    (2–20 steps), `funnelConfigSchema`, and `FUNNEL_CONFIG_VERSION`.
  - `@uptimizr/db`: new dialect-agnostic builder `buildFunnel` — a dynamic-N CTE chain
    using only `JOIN`/`min`/`GROUP BY` (no window or `ASOF` functions) so DuckDB and
    ClickHouse render identically (golden parity coverage on DuckDB). Semantics are
    sequential, first-touch, and monotonic.
  - `@uptimizr/collector-server`: new read endpoint `GET /api/v1/funnel`, wired through
    every store. The funnel definition is supplied per request as a `steps` JSON array
    (validated against `funnelStepsSchema`) and never stored.
  - `@uptimizr/react`: new client method `funnel(steps, params?)`.

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
