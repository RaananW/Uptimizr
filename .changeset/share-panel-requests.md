---
"@uptimizr/react": patch
---

Stop the 3D panels re-fetching every scene's backdrop on each refresh. While a session is open
the panels refresh every 2 s, and each 3D panel listed the scenes and fetched every scene's
representation, about five requests a second with one live session. `CollectorApi` now shares a
GET that is already in flight (each caller gets its own copy of the result) and keeps a scene's
representation for 60 s (a missing one for 5 s), which brings that to under one request a second.
