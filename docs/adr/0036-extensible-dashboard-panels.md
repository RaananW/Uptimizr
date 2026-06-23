# ADR 0036: Extensible dashboard panel contract

- **Status:** Accepted
- **Date:** 2026-06-23
- **Deciders:** Uptimizr maintainers

## Context

The dashboard is, structurally, just a set of rendered views over the collector's query API. Every
panel today follows the same shape: take the global filters (time window, scene, input source,
camera mode) → fetch an aggregate from the collector query API → render it (React/HTML, a 2D
canvas, or a Babylon.js 3D scene) inside the shared `Panel` chrome. The 24 built-in panels differ
only in _which_ query they call, _how_ they draw, and a handful of interaction hooks (time-range
brush, session selection, live SSE updates).

That regularity is an opportunity: if we expose a single, stable panel contract, self-hosters can
write their own panels — a custom metric, a domain-specific visualization, a bespoke table — and
drop them into their dashboard without forking it. The contract is only valuable if it is powerful
enough to express **every** built-in panel; otherwise "extensions" would be second-class.

Two panel patterns already exist in the codebase and must be reconciled:

1. **Prop-drilled dashboard components** (`oss/apps/dashboard/src/components/*`): fed by one large
   `Promise.all` in `page.tsx`, wrapped in the Tailwind `Panel` chrome. Rich (24 panels) but
   hard-coded into the page render tree — there is no registry.
2. **Embeddable self-fetching panels** (`@uptimizr/react` `PointerHeatmapPanel`, `SessionsPanel`,
   …): self-fetch via `UptimizrProvider` + `useAsync`, wrapped in the host-agnostic `PanelCard`.
   Closer to "a user writes a component," but only four exist and they lack global filters, live
   updates, and host interaction hooks.

We need one contract that subsumes both.

## Decision

Introduce a **declarative panel contract** — `PanelDefinition` — that lives in the published
`@uptimizr/react` package, plus a **build-time registry** consumed by the dashboard host.

### The contract (in `@uptimizr/react`)

A panel is a plain object, not a bespoke component tree:

```ts
interface PanelDefinition<TData = void> {
  id: string; // stable, unique
  title: string;
  subtitle?: string | ((ctx: PanelContext) => string | undefined);
  help?: ReactNode;
  span?: 1 | 2; // fixed-grid width (half / full); default 1
  surfaces?: ("overview" | "session")[]; // default ["overview"]
  collapsible?: boolean;
  clientOnly?: boolean; // Babylon/canvas panels render without SSR
  enabled?(ctx: PanelContext): boolean; // visibility (e.g. first-person only)
  load?(ctx: PanelDataContext): Promise<TData>; // omit when self-fetching in render
  render(props: { data: TData; ctx: PanelContext }): ReactNode; // body only
}
```

The **host owns the chrome and the layout**; `render()` returns the panel _body_ only. The
`PanelContext` is the single object a panel needs from its host:

- `api` — the shared `CollectorApi` query client; `baseUrl` / `apiKey` for self-fetch and SSE URLs.
- `params` — `QueryParams` resolved from the global filter bar; `filters` — the raw `FilterState`.
- `surface` + `sessionId` — which view, and the scoped session on the session surface.
- `capabilities` — flags derived from the active range (e.g. `hasFirstPerson`).
- `actions` — `selectSession`, `setTimeRange` (brush), `setFilters`.
- `live` — `{ presence, enabled, subscribe(handler) }` for SSE-driven panels.

This is expressly powerful enough to reproduce all built-in panels: the declarative `load`/`render`
path covers the simple majority, and because `render` also receives the full `ctx`, advanced panels
(self-fetching sub-controls, live streams, 3D scenes) self-manage through the same context. The
contract is host-agnostic — the standalone dashboard wraps each body in the Tailwind `Panel`, while
an embedding app could wrap it in `PanelCard`.

### The registry (build-time, in the dashboard)

Panels are registered in a build-time array (`oss/apps/dashboard/src/panels/registry.ts`). A
self-hoster adds their `PanelDefinition` to one user-owned array and rebuilds. The dashboard
`PanelHost` filters the registry by surface and `enabled(ctx)`, runs each panel's `load()`, wraps
the result in `Panel` chrome with uniform loading/error states, and places it in the fixed grid by
`span`.

### Scoping decisions

- **Build-time registration only.** No runtime/remote module loading in this iteration — that would
  pull in sandboxing, CSP, and module-federation concerns that conflict with the dashboard's static
  `out/` export. The contract is designed so a runtime loader can be layered on later behind the
  _same_ `PanelDefinition` interface. Tracked as a follow-up issue.
- **Fixed grid.** Width is expressed as `span: 1 | 2` (half / full). User-reorderable or persisted
  layouts are out of scope.
- **Contract home is `@uptimizr/react`.** It already houses `CollectorApi`, the draw helpers, and
  the embeddable panels, and it is published, so a panel author imports a type — not Next internals.
  The shared `FilterState` (+ filter helpers) and the `LiveEvent` type move here too, with the
  dashboard re-exporting them (consistent with the existing `lib/api.ts` re-export pattern). The
  dashboard keeps the host wiring: the `PanelHost` grid, the registry, the global filter bar, and
  the built-in panel implementations.

## Consequences

### Positive

- A single, documented extension point: self-hosters add panels without forking the dashboard.
- One contract unifies the two pre-existing panel patterns; chrome and layout live in one place.
- `page.tsx` shrinks from a hard-coded render tree toward filter state + `<PanelHost>`.
- The contract is host-agnostic, so the same panels can render in an embedding app.

### Negative / trade-offs

- Per-panel `load()` replaces the single batched `Promise.all`. Distinct queries still run
  concurrently (panels mount together), but identical queries are no longer deduped for free; a
  shared per-query request cache on the context is a noted future optimization.
- Migrating all 24 built-ins to the contract is incremental: the host and legacy panels coexist
  during the transition (this iteration ports three representative panels — React/HTML, 2D canvas,
  and 3D Babylon — as proof).
- Build-time registration means a self-hoster rebuilds to add a panel; true drop-in panels wait for
  the runtime-loading follow-up.

## Alternatives considered

- **Runtime/remote panel loading from day one** — drop-in third-party modules without a rebuild.
  Rejected for now: sandboxing, CSP, and bundling (module federation) are a separate, larger
  decision and conflict with the static export. Deferred behind the same contract.
- **A new `@uptimizr/dashboard-kit` package for the contract** — cleaner separation, but a new
  published package and dependency for a contract that naturally belongs with the existing
  `CollectorApi` and embeddable panels in `@uptimizr/react`. Rejected as premature.
- **User-reorderable / persisted layouts** — more flexible, but adds layout-state persistence and
  drag-and-drop scope unrelated to the core "write your own panel" goal. Out of scope.
