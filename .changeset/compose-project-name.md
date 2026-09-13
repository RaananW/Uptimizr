---
---

Pin the local Docker stack's Compose project name to `uptimizr-oss`, prefix its containers `uptimizr-oss-*`, make the ClickHouse HTTP and Adminer host ports overridable, and derive the local connection URLs in `.env.example` from the `*_HOST_PORT` variables. Tooling and docs only; no published package changes.
