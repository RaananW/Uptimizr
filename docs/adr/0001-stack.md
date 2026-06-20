# ADR 0001: Tech stack & monorepo tooling

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

Uptimizr needs a single codebase hosting two products (an OSS data-collector and a hosted
SaaS) with shared TypeScript packages (event schema, SDK, DB clients). We want strong types
end to end, fast incremental builds, and a structure that can later be split so the OSS part
becomes its own repository. The owner requires TypeScript for both backend and frontend, and a
cloud-agnostic, Docker-first deployment story (prepared for Azure).

## Decision

- **Language:** TypeScript everywhere (Node.js 22 LTS).
- **Monorepo:** pnpm workspaces for dependency management + **Turborepo** for task
  orchestration and caching (`build`, `lint`, `typecheck`, `test`).
- **Backend / ingestion + query API:** Fastify (see [ADR 0005](./0005-backend-framework.md)).
- **Dashboard / frontend:** Next.js (React) + Tailwind CSS.
- **Validation / contracts:** Zod, exposed through a shared `@uptimizr/schema` package.
- **First 3D connector:** Babylon.js.
- **Deployment:** cloud-agnostic, Docker-first; Azure-specific IaC deferred to Phase 2.

## Consequences

### Positive

- One toolchain, shared types, and atomic cross-package changes.
- Turborepo caching keeps CI and local builds fast as the repo grows.
- pnpm's strict, content-addressed store reduces phantom-dependency bugs.

### Negative / trade-offs

- Contributors must learn pnpm + Turborepo conventions.
- A monorepo needs explicit boundaries to prevent the OSS part from depending on hosted code
  (addressed in [ADR 0004](./0004-monorepo-separation.md)).

## Alternatives considered

- **npm/yarn workspaces without Turborepo** — simpler, but no task graph caching.
- **Nx** — powerful, but heavier and more opinionated than needed here.
- **Vite + React SPA instead of Next.js** — lighter, but Next.js gives routing, SSR/ISR, and a
  smoother path to the hosted dashboard.
