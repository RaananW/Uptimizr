---
"@uptimizr/react": minor
---

Session Replay and Live Presence are now portable panels in `ossPanelCatalog`
(ADR 0049). Adds `sessionReplayPanel` (session surface, Babylon-backed and
code-split; view also exported as `SessionReplayView` from
`@uptimizr/react/panels-3d`) and `livePresencePanel` (overview surface,
Babylon-free) with the `LivePresenceView` body. The per-session live-follow hook
`useLiveSession` and the `LiveStatus` / `LiveSessionState` types move into the
package, and `PanelLive` gains a `status` field so panels can render connection
badges from context.
