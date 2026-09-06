# create-uptimizr

Scaffold a self-host of the Uptimizr OSS 3D-analytics collector in one command —
**Docker-free and single-file (DuckDB)** by default, or backed by the Postgres,
ClickHouse or SQL Server store you already run.

```bash
npm create uptimizr@latest my-analytics
# or pick the engine + name up front:
npm create uptimizr@latest my-analytics -- --engine three --name "My Game"
# or scaffold the full suite (collector + dashboard + runnable demo):
npm create uptimizr@latest my-analytics -- --full
# or point it at an external database instead of DuckDB:
npm create uptimizr@latest my-analytics -- --store postgres
```

It generates a ready-to-run folder:

```
my-analytics/
  package.json          # scripts wired to the `uptimizr` CLI (+ the chosen store package)
  .env                  # generated visitor-hash secret + store config (git-ignored)
  .gitignore
  README.md
  client-snippet.<engine>.ts   # paste-ready connector wiring for your app
  demo/                 # (optional, --demo) a runnable Babylon scene + tiny static server
  data/                 # (DuckDB only) the store file lives here
```

Then:

```bash
cd my-analytics
npm install
npm run setup     # mints your first project + API key (printed once)
npm start         # ingestion + query API on http://localhost:4318
```

## Optional features

By default the scaffold is **collector only**. When run interactively you're
asked whether to add each extra; non-interactively, pass the flags. They let you
go from a bare collector to the **full suite** so you can test everything in one
go:

- **Dashboard (`--dashboard`)** — adds `@uptimizr/dashboard` and an
  `npm run dashboard` script (serves the analytics UI on
  `http://localhost:3000`; point its connection bar at the collector with your
  API key). The collector's `COLLECTOR_CORS_ORIGINS` is widened to allow it.
- **Demo (`--demo`)** — writes a self-contained Babylon demo scene + a
  zero-dependency static server and an `npm run demo` script (serves on
  `http://localhost:5173`). Paste the `projectId` from `npm run setup`, then
  orbit/click the scene to generate camera, pointer, and mesh events. It uses
  Babylon (the reference connector) regardless of your chosen client engine.
- **`--full`** — both of the above. `--minimal` forces collector only (skips the
  prompts).

With the full suite, run three processes (`npm start`, `npm run demo`,
`npm run dashboard`) to watch events flow from the demo through the collector
into the dashboard.

## Choosing a store

The collector keeps events **and** metadata in one store, selected by
`COLLECTOR_STORE` in the generated `.env`. When run interactively you're asked
which one; non-interactively, pass `--store`:

- **`duckdb`** (default) — a single `.duckdb` file under `data/`. No Docker, no
  database server, nothing else to install.
- **`postgres`** — the single-tenant [`@uptimizr/db-postgres`](../db-postgres)
  store. `.env` gets `POSTGRES_URL` (the database must already exist).
- **`clickhouse`** — the single-tenant
  [`@uptimizr/db-clickhouse`](../db-clickhouse) store for high-volume ingestion.
  `.env` gets `CLICKHOUSE_URL` / `CLICKHOUSE_DATABASE` / `CLICKHOUSE_USER` /
  `CLICKHOUSE_PASSWORD`.
- **`mssql`** — the single-tenant [`@uptimizr/db-mssql`](../db-mssql) store for
  SQL Server 2022+ / Azure SQL. `.env` gets `MSSQL_URL`.

For the external stores the scaffold adds the store package to `package.json`,
writes local-server placeholder connection settings you edit to match your
database, and skips the `data/` folder. Start the database, then `npm run setup`
creates the schema and mints the first project + API key there — the `uptimizr`
CLI honours `COLLECTOR_STORE` for `init` / `new-project` / `migrate` just like
`serve` does (collector-server 1.1.0+).

## Options

| Flag             | Default              | Description                                                              |
| ---------------- | -------------------- | ------------------------------------------------------------------------ |
| `[dir]`          | `uptimizr-analytics` | Folder to create (prompted when interactive).                            |
| `--engine <e>`   | `babylon`            | `babylon`, `babylon-lite`, `three`, `r3f`, `playcanvas`, `aframe`.       |
| `--store <s>`    | `duckdb`             | `duckdb`, `postgres`, `clickhouse`, `mssql` (prompted when interactive). |
| `--name <name>`  | folder name          | Human-readable project name.                                             |
| `--port <n>`     | `4318`               | Collector port baked into config + snippet.                              |
| `--dashboard`    | off                  | Include the analytics dashboard (`@uptimizr/dashboard`).                 |
| `--no-dashboard` | —                    | Set dashboard inclusion off.                                             |
| `--demo`         | off                  | Include a runnable Babylon demo scene.                                   |
| `--no-demo`      | —                    | Set demo inclusion off.                                                  |
| `--full`         | off                  | Full suite: collector + dashboard + demo.                                |
| `--minimal`      | —                    | Collector only; skip the interactive prompts.                            |

The scaffolder only writes files — the generated folder is operated entirely via
the [`uptimizr` CLI](../../apps/collector-server#readme) (`init` / `serve` /
`new-project` / `migrate`); it never reimplements collector logic.
