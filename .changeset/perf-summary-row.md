---
"@uptimizr/react": patch
---

`CollectorApi.perf()` now unwraps the one-row result set every store returns for `GET /api/v1/perf`. The rendering-performance panel and the scene-health "Avg FPS" tile read that summary and were always showing "no performance samples" because the client treated the array as an object.
