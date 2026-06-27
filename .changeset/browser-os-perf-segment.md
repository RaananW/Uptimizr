---
"@uptimizr/collector-server": minor
"@uptimizr/schema": minor
"@uptimizr/db": minor
"@uptimizr/react": minor
---

Add a browser/OS performance segment derived from the request User-Agent at
ingestion (#11). The collector reduces the User-Agent to a coarse, non-PII
`{ browser, os }` pair (raw UA never stored) and merges it into
`session_start.device`; `buildPerfByDevice` and the dashboard "FPS by device"
panel now segment per-session median FPS by browser/OS in addition to graphics
backend, mobile flag, and GPU renderer. No SDK, schema-capture, or storage
migration change (ADR 0041).
