---
"@uptimizr/sdk-core": patch
"@uptimizr/react": patch
"@uptimizr/dashboard": patch
---

Keep every click in first-person and live sessions. `createClickGuard()` never treats a click as a drag under Pointer Lock, since a crosshair click is aimed, not dragged, and turning with the button held is looking around; the three.js, PlayCanvas, Babylon Lite and web-export connectors inherit it. The session replay's live follow dropped any event that shared a millisecond with the one before it, and a click's press, release, click and pick usually share one, so most live clicks never drew a ray. It now dedupes the live stream by event identity, and clicks that arrive in the same batch pulse one after another with their real spacing instead of all at once.
