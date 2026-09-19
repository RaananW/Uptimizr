---
"@uptimizr/schema": minor
"@uptimizr/db": minor
"@uptimizr/db-postgres": minor
"@uptimizr/db-mssql": minor
"@uptimizr/db-clickhouse": minor
"@uptimizr/collector-server": minor
"@uptimizr/agent-core": minor
"@uptimizr/mcp": minor
"@uptimizr/react": minor
"@uptimizr/dashboard": minor
---

Conditional subscriptions, an SSE stream and signed webhooks (ADR 0051 §6). A subscription names a
registry metric, a window and a predicate — `threshold`, `anomaly`, `movers`, `new_value` or
`presence` — and the collector evaluates it in-process on a bounded scheduler, records each firing
in a per-subscription log and delivers it over SSE and/or an HMAC-signed webhook. Webhook egress is
disabled until `COLLECTOR_WEBHOOK_ALLOWED_HOSTS` names the hosts the collector may reach, and a
webhook secret is write-only. Adds `/api/v1/subscriptions*`, a read-only dashboard panel, a
`list_subscriptions` agent tool and `uptimizr subscriptions list|add|remove|test`.
