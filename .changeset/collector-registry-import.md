---
"@uptimizr/collector-server": patch
---

Read the metric registry from `@uptimizr/metrics` instead of the removed `@uptimizr/db/registry`
subpath. `GET /api/v1/openapi.json` and the registry route checks are unchanged — same 69 metrics,
same document.
