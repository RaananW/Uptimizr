# ADR 0041: Runtime / remote dashboard panel loading

- **Status:** Accepted
- **Date:** 2026-06-27
- **Deciders:** Project owner, engineering

## Context

[ADR 0036](./0036-extensible-dashboard-panels.md) introduced the declarative panel contract —
`PanelDefinition` in `@uptimizr/react` — and a **build-time** registry: a self-hoster appends a
definition to the `builtinPanels` array in `oss/apps/dashboard/src/panels/registry.tsx` and
rebuilds the dashboard. [ADR 0039](./0039-viewer-configurable-panels.md) layered viewer-configurable
visibility + per-panel settings on top.

ADR 0036 deliberately scoped out runtime/remote loading ("the contract is designed so a runtime
loader can be layered on later behind the _same_ `PanelDefinition` interface. Tracked as a
follow-up issue."). That follow-up is issue #61: self-hosters want to add a panel — a custom
metric, a domain-specific visualization — **without** rebuilding the dashboard, e.g. by pointing it
at a remote manifest.

The hard parts the follow-up flagged: a manifest describing available panels, **safe loading** of
remote modules (they execute in the dashboard — a trust decision), **versioning** the contract so a
remote panel can declare compatibility, and surfacing per-panel load/enable errors **without
breaking the grid**. The dashboard also ships as a static export (`out/`), so any loader must run
client-side at runtime rather than bundling modules at build time.

## Decision

Add a runtime loader **behind the existing `PanelDefinition` contract** — no change to how panels
are authored. The framework-agnostic loader lives in `@uptimizr/react` (where the contract lives);
the dashboard owns the host wiring (config, when to fetch, how to surface errors).

### Contract versioning

`@uptimizr/react` exports `PANEL_CONTRACT_VERSION` (an integer **major**). A manifest entry declares
the `contract` major it was built against; the host loads an entry only when its declared major
equals the running version, otherwise it records an `incompatible` error. The major is bumped on a
breaking change to `PanelDefinition` / `PanelContext`; additive changes keep the same major.

### The manifest + loader (`@uptimizr/react`)

A `PanelManifest` is `{ version, panels: [{ url, contract, export?, id? }] }`. The loader
(`fetchPanelManifest`, `loadRemotePanels`, `mergePanels`) is pure and injectable (custom
`importModule` / `fetchImpl`), so it is fully unit-tested without a network. It:

- validates the manifest shape and each panel's structure (`isPanelDefinition` guards the
  load-bearing fields, since a remote module's types can't be trusted);
- version-gates each entry, enforces an optional origin allowlist, dynamically `import()`s the
  module (annotated so bundlers leave the runtime URL alone), and reads the named/`default` export;
- **isolates failures per entry** — a bad panel becomes a `RemotePanelError` and is skipped, never
  blocking the rest — and returns `{ panels, errors }`.

### Host wiring (dashboard)

`getRemotePanelConfig` reads two build-time env vars —
`NEXT_PUBLIC_PANELS_MANIFEST_URL` (comma-separated) and `NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS`. The
`useRemotePanels` hook fetches + loads on mount (client-side, once, never throwing). `page.tsx`
merges remote panels with `builtinPanels` via `mergePanels` (built-ins win id collisions) and
renders a dismissible banner listing any `RemotePanelError`s. `PanelHost` is hardened: a throwing
`enabled(ctx)` hides just that panel, and a per-panel error boundary catches a throwing `render` so
a misbehaving panel shows an inline error inside its own chrome instead of crashing the grid.

### Trust model

Remote panels execute **with the dashboard's full privileges** (the rich `PanelContext`: API
client, live SSE, host actions). We **do not** sandbox via iframe/worker — that would sever the
context the contract is built around and make most panels impossible. Instead:

- **Opt-in, off by default.** No manifest URL ⇒ the dashboard behaves exactly as before.
- **Origin allowlist** as a guardrail (not a sandbox): the loader refuses module URLs whose origin
  is not allowlisted, when one is configured.
- **Documented trust requirement:** only point the manifest at sources you trust; prefer serving
  panel modules from an origin you control.

### Scoping

- **No iframe/worker sandbox** this iteration (would break the contract; a larger, separate
  decision if ever needed).
- **No Playwright E2E** this iteration — exercising real remote module loading needs a served
  fixture module + manifest, which is disproportionate; the loader, config, and merge are covered
  by unit tests instead. Deferred.

## Consequences

### Positive

- Self-hosters add panels at runtime from a manifest — no dashboard fork or rebuild — through the
  same `PanelDefinition` they already use.
- The contract is now versioned, so remote panels can declare compatibility and fail loudly when
  they don't match.
- Load/enable/render failures are isolated and surfaced; one bad panel never breaks the grid.
- Backward compatible and static-export safe: build-time registration is untouched; loading is
  purely additive, client-side, and disabled unless configured.

### Negative / trade-offs

- Remote panels are **full-trust code**; the safety story is opt-in config + an origin allowlist +
  documentation, not a sandbox. Misuse (pointing at an untrusted origin) can execute arbitrary code
  in the dashboard.
- No E2E coverage of the runtime path yet (deferred).

## Alternatives considered

- **iframe / Web Worker sandbox** — real isolation, but a worker can't render React/DOM and an
  iframe severs the shared React tree and `PanelContext` (API client, live SSE, host actions) the
  contract hands every panel. Rejected: it would make remote panels second-class and contradict the
  ADR 0036 goal that extensions are first-class.
- **A signed-bundle / plugin-registry trust system** — stronger provenance, but heavy
  infrastructure for a self-hosted OSS collector. Deferred; the opt-in + allowlist + docs model is
  proportionate for now.
- **Keep build-time only** — simplest, but doesn't solve #61 (rebuild to add a panel).
