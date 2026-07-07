# ADR 0049: Session Replay and Live Presence are portable catalog panels

- **Status:** Accepted
- **Date:** 2025-02-16
- **Deciders:** Dashboard / SDK maintainers

## Context

ADR 0047 moved the OSS panel set into `@uptimizr/react` as the portable
`ossPanelCatalog`, but deliberately left three surfaces in the dashboard
**shell**: the session inspector, **Session Replay**, and the **Live Presence**
roster with its SSE wiring. The reasoning was that these lean on live
connections and per-session drill-down state that felt app-specific.

In practice that carve-out meant a downstream consumer that mirrors the catalog
(ADR 0047's motivation) could reproduce every analytics panel _except_ the two
that best showcase the product: watching a session replay and seeing who is on
the scene right now. The panel contract already models everything they need —
`surfaces: ["session" | "overview"]`, `clientOnly`, `ctx.live`
(presence / `enabled` / `subscribe` / `sceneId` / `status`), `ctx.sessionId`,
`ctx.actions.selectSession`, and self-fetching in `render` — so the exclusion
was a boundary choice, not a technical limit. Only the per-session live-follow
hook (`useLiveSession`) and the `LiveStatus` / `LiveSessionState` types still
lived in the app.

## Decision

Promote **Session Replay** and **Live Presence** into `ossPanelCatalog` as real
`PanelDefinition`s, revising the ADR 0047 boundary. The session **inspector**
(the event-type toggle UI) stays in the dashboard shell for now.

- **`sessionReplayPanel`** (`id: "session-replay"`, `surface: "session"`,
  `clientOnly`) — Babylon-backed, so its view is code-split behind `React.lazy`
  exactly like the other 3D panels; importing the catalog never loads
  `@babylonjs/*` at module-eval. The view is also exported from
  `@uptimizr/react/panels-3d` as `SessionReplayView` for hosts that mount it
  directly. It self-fetches the session tail and, when the session is live
  (`ctx.live` presence contains `ctx.sessionId`), follows it in real time.
- **`livePresencePanel`** (`id: "live-presence"`, `surface: "overview"`) —
  Babylon-free, eagerly imported. Its `LivePresenceView` is exported from the
  package root. It renders the "N live now" badge, the non-identifying roster,
  and a rolling event feed from `ctx.live`.
- The per-session live layer moves into the package:
  `useLiveSession` + `LiveStatus` + `LiveSessionState` now live in
  `@uptimizr/react`. `PanelLive` gains `readonly status: LiveStatus` so panels
  can render connection badges from context. The dashboard's aggregate presence
  and firehose hooks (`useLivePresence`, `useLiveStream`) stay in the shell and
  re-export the moved types.
- **`@uptimizr/react` gains `@uptimizr/replay` as a dependency**, since Session
  Replay drives a session through the replay engine. It is only reached through
  the lazy 3D chunk, so the Babylon-free core is unaffected.
- The dashboard stays a **thin consumer**: it renders the same two views at
  their prominent positions and passes `exclude` to `PanelHost` (a new optional
  prop) so the host does not double-render them. There is one implementation of
  each panel — no fork, no layout regression.

This is additive and non-breaking: prior exports keep working and
`PANEL_CONTRACT_VERSION` is unchanged (adding an optional-in-practice `status`
that the dashboard already supplies).

## Consequences

### Positive

- A downstream consumer can now mirror the **entire** OSS experience — including
  Session Replay and Live Presence — from `@uptimizr/react` alone.
- One implementation per panel; the dashboard no longer keeps bespoke
  `SessionReplay`/`LivePresence` components.
- Babylon and the replay engine stay code-split; the core bundle is unchanged.

### Negative / trade-offs

- The portable `sessionReplayPanel` shows all event types (it does not thread the
  inspector's `hiddenTypes` filter, which still lives in the shell). The
  dashboard's direct `SessionReplayView` mount keeps passing `hiddenTypes` to
  preserve the inspector ↔ replay link, so there is a small behavioral gap
  between the catalog panel and the dashboard mount. Unifying the inspector is
  deferred.
- `PanelHost` grows an `exclude` prop so a host can render a catalog panel's view
  itself while suppressing the host-driven copy.

## Alternatives considered

- **Keep them in the shell (ADR 0047 as-is).** Rejected — it leaves the two most
  compelling panels un-mirrorable, defeating the point of the portable catalog.
- **Fork the views: catalog copy + dashboard copy.** Rejected — two
  implementations drift; the whole ADR 0047 goal is one source of truth.
- **Also move the session inspector now.** Deferred — its event-type toggles
  mutate shell state shared with other components; moving it is a separable
  change and not required to make replay/presence portable.
