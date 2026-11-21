---
"@uptimizr/collector-server": minor
---

`GET /api/v1/openapi.json` now describes the non-metric routes an agent needs: `whoami` and the audit trail (`identity`), the scene-region reads and the region and representation writes (`scene-registry`), the raw session event timeline (`raw`), the live-token exchange and the three live SSE streams (`live`), and `POST /api/v1/collect` (`ingest`). Each new operation states the capability it needs in `x-uptimizr-capability`; bodies and parameters are converted from the Zod schemas that validate them.
