# ADR 0005: Backend framework — Fastify (Hono for edge later)

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

The collector's hot path is a public `POST /api/v1/collect` endpoint absorbing high-volume
batched events before writing to ClickHouse. We need low per-request overhead, first-class
TypeScript, native request validation (against the `@uptimizr/schema` Zod contracts), and the
security plumbing expected of a public ingestion endpoint (CORS, rate limiting, security
headers). The hosted Phase 2 service may later move ingestion to an edge/CDN runtime.

## Decision

- **Phase 1 OSS `collector-server`: Fastify.** Chosen for its high throughput, native
  JSON-Schema/Zod validation (via `fastify-type-provider-zod`), strong TypeScript support, and a
  focused plugin ecosystem (`@fastify/cors`, `@fastify/rate-limit`, `@fastify/helmet`). Its
  encapsulation model cleanly separates ingestion routes from query routes. Self-hostable via
  Docker.
- **Phase 2 hosted edge ingestion: revisit Hono.** If hosted ingestion moves to edge/Cloudflare
  Workers, Hono is the leading candidate. This is **not** decided now and will get its own ADR
  in Phase 2.

## Consequences

### Positive

- Fast, low-overhead ingestion suited to the event firehose.
- Validation at the edge of the service with minimal boilerplate, reusing shared Zod schemas.
- Mature plugins cover CORS, rate limiting, and security headers out of the box.

### Negative / trade-offs

- Two frameworks may eventually coexist (Fastify for self-host, Hono for hosted edge),
  increasing surface area — mitigated by keeping all business logic in framework-agnostic
  packages (`@uptimizr/schema`, `@uptimizr/db`).

## Alternatives considered

- **Express** — most popular, but slower, weaker TypeScript story, and validation/security are
  all bolt-ons.
- **NestJS** — more built-in structure (DI, decorators), but heavier and more opinionated than a
  lean ingestion service needs; it also runs on top of Fastify anyway.
- **Hono (now, everywhere)** — excellent and edge-friendly, but for a Docker-first self-hosted
  collector Fastify's ecosystem and maturity win in Phase 1.
