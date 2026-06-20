# Uptimizr

> 3D scene analytics — like Google Analytics, but for 3D applications.

Uptimizr captures and visualizes how people actually use 3D scenes: where they
**look** (view-direction heatmaps), where they **point and click** (2D + 3D raycast
heatmaps), which **meshes** they interact with, how the scene **performs** (FPS, device/GPU,
asset load times), and any **custom events** a developer wants to track. It can also
**replay** an individual session inside the developer's own scene.

Google Analytics is built for 2D HTML pages and custom events; it has no concept of a
camera, a view vector, or a mesh. Uptimizr fills that gap.

## Self-hostable, open source

Uptimizr is an **open-source data-collector** — a self-hostable SDK + ingestion + dashboard,
licensed Apache-2.0. Run it on a single embedded DuckDB file with no external database service,
or scale out to ClickHouse + Postgres when you need to.

## Tech stack

- **Monorepo:** pnpm workspaces + Turborepo · TypeScript everywhere
- **Ingestion/query API:** Fastify ([ADR 0005](./docs/adr/0005-backend-framework.md))
- **Dashboard:** Next.js + Tailwind
- **Event store (default):** a single embedded **DuckDB** file holds events **and** metadata — no
  external database service ([ADR 0020](./docs/adr/0020-open-core-storage-boundary.md))
- **Event store (optional scale tier):** ClickHouse (events) + Postgres (metadata)
  ([ADR 0002](./docs/adr/0002-database.md))
- **First 3D connector:** Babylon.js (three.js connector also available)
- **Privacy:** cookieless / GDPR-first by default ([ADR 0003](./docs/adr/0003-privacy-model.md))

## Repository layout

```
oss/        Open-source product (Apache-2.0)
  apps/       collector-server (Fastify), dashboard (Next.js)
  packages/   schema, sdk-core, sdk-babylon, sdk-three, replay, db (DuckDB store + contracts)
examples/   babylon-playground, three-playground — demo scenes for end-to-end testing
infra/      docker-compose for the optional ClickHouse + Postgres scale engines
docs/       architecture, phase plans, and ADRs
```

## Getting started

There are two ways in, depending on whether you're **using** Uptimizr in your own app or **working on
the project** itself.

### Use Uptimizr in your app (from npm — no clone)

**You don't need this repo to use Uptimizr.** Install a connector from npm and run the collector
straight from npm:

```bash
npm i @uptimizr/babylon                              # or @uptimizr/three, @uptimizr/r3f, …
npm create uptimizr@latest                           # scaffold a Docker-free, single-file self-host
# …or run the collector CLI directly:
npx -p @uptimizr/collector-server uptimizr init      # create the DuckDB store + a project + API key
npx -p @uptimizr/collector-server uptimizr serve     # ingestion + query API on http://localhost:4318
```

See the [Quickstart](https://uptimizr.com/docs/quickstart/) and
[Run the collector](https://uptimizr.com/docs/deploy/collector/) for the full guide.

### Work on Uptimizr from source (contributors)

The commands above are all you need to _use_ Uptimizr. The rest of this section is for **contributing
to the project itself** — clone the repo and run it from source. The open-source collector stores
everything in a single DuckDB file, so running from source needs **no external database service**:

```bash
pnpm install
pnpm build                       # turbo build across all packages
pnpm lint && pnpm typecheck && pnpm test

cp .env.example .env             # DUCKDB_PATH defaults to ./data/uptimizr.duckdb
pnpm db:setup                    # create the DuckDB file + seed a project & API key
pnpm dev:collector               # Fastify ingestion + query API (COLLECTOR_STORE=duckdb)
pnpm dev:dashboard               # optional: the analytics dashboard
```

- **Back up** = copy the `.duckdb` file. **Reset** = delete it and re-run `pnpm db:setup`.
- **Single-writer constraint:** DuckDB is embedded and single-writer — only one process may open
  the file read-write at a time. Run a single collector per file. For multi-writer / horizontal
  scale, use the optional ClickHouse + Postgres scale tier (via `infra/docker`)
  ([ADR 0020](./docs/adr/0020-open-core-storage-boundary.md)).

To run the full stack locally and verify it end-to-end (collector, dashboard, Babylon
playground, replay), follow the [manual testing guide](./docs/manual-testing.md) and the
`run-local-stack` skill. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for conventions and house rules.

## Documentation

- [Manual testing guide](./docs/manual-testing.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Phase plans](./docs/phases)
- [Architecture Decision Records](./docs/adr)
- [Contributing](./CONTRIBUTING.md)
- [Agent guide (`AGENTS.md`)](./AGENTS.md)

## License

The open-source product (`oss/`, `examples/`, `infra/`, `docs/`) is licensed under
[Apache-2.0](./LICENSE).
