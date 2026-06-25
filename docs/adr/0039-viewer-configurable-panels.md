# ADR 0039: Viewer-configurable panels — visibility + per-panel settings

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Uptimizr maintainers
- **Extends:** [ADR 0036](./0036-extensible-dashboard-panels.md) (does not supersede it)

## Context

ADR 0036 made dashboard panels a declarative `PanelDefinition` contract: a panel's behaviour is
fixed at **registration** time and reacts only to the **global** filter bar. There is no per-panel,
per-viewer control. Two gaps surfaced in practice (#79):

1. **No visibility control.** A viewer can't remove a panel they don't care about, nor bring it
   back. The grid shows every registered, surface-eligible, `enabled` panel — all or nothing.
2. **No per-panel configuration.** A panel's tunables are either compile-time constants (a
   developer editing the definition) or global filters. Surfaced while porting the floor-plan dwell
   heatmap (#66): `FLOOR_CELL_SIZE = 1` is a hardcoded module constant, so a viewer can't change the
   spatial resolution — dwelling in one spot just stays saffron with no way to coarsen/sharpen it.

Both are **viewer-scoped, runtime** concerns. ADR 0036 deliberately deferred "user-reorderable /
persisted layouts"; this ADR adds the smaller, orthogonal slice of that — visibility and typed
settings — while leaving drag-reorder/resize out.

## Decision

Extend the ADR 0036 contract (not rewrite it) with a **per-panel settings** schema and a
**viewer-state persistence seam**, and teach the host to render the visibility + settings chrome.

### 1. Typed per-panel settings (`@uptimizr/react`)

`PanelDefinition` gains an optional `settings` map of typed primitives, and `PanelContext` gains the
resolved values under `ctx.settings`. The primitive set is intentionally tiny — no forms framework:

```ts
type PanelSettingSpec =
  | { type: "number"; default: number; min?: number; max?: number; step?: number; unit?: string; label?: string; help?: string }
  | { type: "boolean"; default: boolean; label?: string; help?: string }
  | { type: "select"; default: string; options: { value: string; label?: string }[]; label?: string; help?: string };

interface PanelDefinition<TData = void, TSettings extends PanelSettings = PanelSettings> {
  // …ADR 0036 fields…
  settings?: TSettings;
  load?(ctx: PanelDataContext<TSettings>): Promise<TData>; // ctx.settings is typed
  render(props: { data: TData; ctx: PanelContext<TSettings> }): ReactNode;
}
```

`PanelContext` / `PanelDefinition` / `definePanel` became generic over `TSettings`, so a panel that
declares `settings` reads precisely typed values (e.g. `ctx.settings.cellSize: number`). Panels that
declare none keep `ctx.settings` as an empty object. The **host** resolves each panel's effective
settings (defaults overlaid with the viewer's overrides) and injects them into that panel's context
before `enabled` / `load` / `render`. `usePanelData` keys its refetch on `ctx.settings` too, so
changing a setting re-runs `load` exactly like a filter change.

Resolution is centralised in `resolvePanelSettings(spec, overrides)`: numbers are clamped to
`[min,max]`, selects must match a declared option, type mismatches fall back to the default, and
unknown override keys are ignored — so persisted state can't break a panel as its settings evolve.

### 2. Persistence seam (`PanelStateStore`)

Viewer state — `{ hidden: string[]; settings: { [panelId]: { [key]: value } } }` — lives behind a
small synchronous store interface:

```ts
interface PanelStateStore {
  load(): PanelState;
  save(state: PanelState): void;
}
```

`@uptimizr/react` ships two implementations: `createLocalStoragePanelStore(key)` (the default;
SSR-safe — degrades to empty when there's no `window`) and `memoryPanelStore` (a no-op for SSR /
disabled persistence). An embedding host can supply its own store (e.g. backed by a user-prefs API).

**Keying: per surface.** Each dashboard surface (`overview`, `session`) persists under its own key
(`uptimizr:dashboard:panels:<surface>`). Visibility is inherently surface-specific, and keeping
settings beside it keeps one simple, fully-reversible blob per surface rather than a cross-surface
merge. Overrides equal to a default are pruned, so the stored blob stays minimal and "reset to
defaults" simply drops keys.

### 3. Host chrome (dashboard `PanelHost`)

- Each panel gets a hide ("×") action; hidden panels drop out and appear in a **"Hidden panels"**
  manage bar with per-panel restore + "Show all". Always reversible.
- Panels declaring `settings` get a "⚙" toggle that reveals a host-rendered `PanelSettingsForm`
  (slider / toggle / select) wired to the store.
- SSR-safe: the first paint applies the empty state (matching server HTML); stored state is applied
  after mount, so a hidden `clientOnly` panel just drops out post-hydration with no mismatch.

### 4. Adopters

The floor-plan dwell heatmap exposes `cellSize` (0.25–5 m slider, default 1) as the reference
setting and gains a heat legend. `FLOOR_CELL_SIZE` stays only as the slider's default.

The same data-resolution pattern then rolled out to the rest of the binned/capped panels (#79),
each turning a former module constant into a viewer slider that re-runs the panel's `load`:

| Panel | Setting | Default |
| --- | --- | --- |
| View-direction dome (3D) | `bins` — angular resolution | 36 |
| World heatmap (3D) | `cellSize` — voxel size | 0.5 m |
| Gaze ↔ click divergence (3D) | `cellSize` — shared voxel size | 0.5 m |
| Pointer heatmap | `bins` — grid resolution | 50 |
| Click → part flow (Sankey) | `maxLinks` — link cap | 80 |
| Top meshes | `limit` — Top N | 25 |

Each former constant survives only as its slider's default, so nothing changes until a viewer
opts in. Purely visual knobs (marker shape, opacity) are deferred until the contract grows a
render-only setting flag that skips the refetch a value change currently triggers.

## Consequences

### Positive

- Viewers tailor their dashboard (hide noise, tune resolution) without forking or rebuilding.
- The settings contract is declarative and host-agnostic — embeds reuse `resolvePanelSettings` and
  the store seam; a panel author adds a `settings` map and reads `ctx.settings`.
- Persisted, fully reversible, and migration-safe (defaults fill gaps; stale keys are dropped).

### Negative / trade-offs

- A second generic (`TSettings`) on the panel types. It defaults to the loose record, so existing
  one-arg `definePanel<TData>` panels are unaffected; only panels wanting typed settings pass it.
- Settings are keyed per surface, so the same panel on `overview` and `session` keeps independent
  values. Acceptable for the current panels; a shared/global scope can be layered on the seam later.
- Viewer state is per-device (localStorage). Cross-device sync is explicitly out of scope.

## Alternatives considered

- **A general forms/JSON-schema settings framework** — far more power than needed; rejected for the
  three-primitive set the host can render directly.
- **Server-side / cross-device sync of preferences** — useful but a separate concern (auth, storage,
  conflict resolution); the `PanelStateStore` seam leaves room for it without changing panels.
- **Drag-to-reorder / resizable layouts** — the other half of "configurable dashboard"; orthogonal
  to visibility + settings and deferred (still out of scope per ADR 0036).
- **Keeping `cellSize` a global filter** — pollutes the shared filter bar with panel-specific knobs;
  per-panel settings keep tunables where they belong.
