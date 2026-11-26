---
"@uptimizr/react": patch
"@uptimizr/dashboard": patch
---

Keep an open live session's panels current, and cheaper to refresh. The session view reused the overview's time window, whose `until` froze when the session opened, so its once-a-second refetches re-read the same past window and nothing changed until you left and came back. The session surface now moves its window forward on each refresh, refreshes only when new events for that session arrive (at most every 2 s, instead of refetching every panel every second), and also refreshes the session data inspector. `usePanelData` coalesces a refresh that lands while a load is in flight instead of aborting it, and every 3D panel releases its WebGL context on unmount (`loseContextOnDispose`), so switching between the overview and a session no longer exhausts the browser's context limit and kills a live canvas.
