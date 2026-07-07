---
"@uptimizr/react": minor
---

Route the Session Replay catalog panel through the panel contract's data seam so
it works on any host that backs `ctx.api` — not just a browser talking straight
to a collector with a project key.

`CollectorApi` gains two additive methods:

- `sessionEvents(sessionId)` — the session's ordered raw events (the ADR 0015
  replay backfill), fetched from the collector's replay endpoint with the key.
- `liveSession(sessionId, handler, options?)` — a subscription-style per-session
  live tail mirroring `PanelLive.subscribe`, returning an unsubscribe function.
  Each `CollectorApi` implementation owns its own connection details (a host can
  add cookies / `withCredentials`, which a URL + token can't express). The
  existing `liveToken` / `liveSessionUrl` builders stay for other consumers.

`SessionReplayView` now takes `api: CollectorApi` (instead of `baseUrl`/`apiKey`)
and backfills + live-tails purely through those seams; the Flow Sankey panel is
switched to `ctx.api` the same way. A static assertion now enforces that no
catalog panel reads `ctx.baseUrl` / `ctx.apiKey` or constructs its own client —
all data flows through `ctx.api` / `ctx.live`.

Hosts that back `ctx.api` get session replay (historical + live-tail) for free
and can drop any same-id substitute panel, implementing the two new
`CollectorApi` methods against their own cookie-authed replay + per-session tail.
