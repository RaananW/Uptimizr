---
description: Collector server (Fastify) conventions — ingestion, query, and security.
applyTo: "oss/apps/collector-server/**"
---

# Collector server (Fastify)

The public-facing ingestion + query API. Treat all client input as untrusted.

## Structure & framework

- Fastify with the Zod type provider (`fastify-type-provider-zod`); validate every request body
  against `@uptimizr/schema`. Reject invalid batches with `400`.
- Keep business logic in framework-agnostic helpers / `@uptimizr/db`; route handlers stay thin
  so the framework could be swapped (ADR 0005).
- Separate ingestion routes from query routes via Fastify encapsulation (plugins).

## Ingestion (`POST /api/v1/collect`)

- Accept **batched** events. Validate → enrich → insert.
- **Enrich** server-side: derive the cookieless visitor hash `hash(ip + ua + dailySalt)` (daily
  rotation), optional coarse geo. Never store the raw IP. (ADR 0003)
- Insert into ClickHouse via batched/async inserts (`@uptimizr/db`). Don't block the request on
  slow inserts beyond what's needed for durability guarantees.
- Honor `ENABLE_RAW_SESSION_RETENTION`: only persist raw ordered session streams when enabled.
- **Ingest is unauthenticated by design.** The SDK ships events with `navigator.sendBeacon`,
  which cannot attach secret headers, so the public `projectId` is the only credential (like a
  GA measurement ID). Compensate at the boundary: a batch must share one `projectId` (reject
  mixed batches `400`), the project must exist (`store.projectExists` → `401` otherwise), apply a
  dedicated per-route ingest rate limit (`COLLECTOR_INGEST_RATE_LIMIT_*`), and cap the body size
  (`COLLECTOR_BODY_LIMIT`). Do not add a secret-header auth scheme to `/collect`.

## Query API

- Aggregations (heatmap grids, top meshes, sessions, perf) computed **at query time** in v1
  (materialized views are Phase 2 — ADR 0002).
- `GET /api/v1/sessions/:id/events` returns the ordered session timeline for replay.

## Security (public endpoint)

- `@fastify/cors` (restrict to configured origins), `@fastify/rate-limit`, `@fastify/helmet`.
- Authenticate query/read routes with project API keys (from Postgres) as appropriate. Ingest is
  the deliberate exception (see above).
- Never log secrets, raw IPs, or full payloads at info level. The logger is configured to omit
  the client IP/`remoteAddress` and to redact `?token=` from URLs; keep it that way.
- **TLS is mandatory in production but terminated upstream** — the collector speaks plain HTTP
  behind a reverse proxy / load balancer. When proxied, set `COLLECTOR_TRUST_PROXY` so the real
  client IP (used for visitor hashing + rate limiting) is read from `X-Forwarded-For`; never
  trust the proxy headers when the collector is directly reachable.
- **CSP for the served dashboard:** the dashboard ships as a static export (no per-request server
  runtime), so it cannot mint per-request nonces. When serving it all-in-one, helmet builds a
  strict policy that pins the inline bootstrap scripts by **SHA-256 hash** (`src/csp.ts`,
  computed from the export at startup) rather than `'unsafe-inline'`. `COLLECTOR_CSP=off`
  disables it for debugging only. The standalone dashboard server (`server/standalone.mjs`) sets
  the equivalent headers itself.
- Configuration via env (see `.env.example`); fail fast if required secrets are missing.
