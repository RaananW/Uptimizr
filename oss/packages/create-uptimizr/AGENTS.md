# AGENTS.md — create-uptimizr

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The scaffolder for a self-hosted Uptimizr OSS collector (ADR 0029) — **Docker-free and
single-file (DuckDB)** by default, or backed by the Postgres, ClickHouse or SQL Server store you
already run.

**It only writes files.** The generated folder is operated entirely by the
[`uptimizr` CLI](../../apps/collector-server) (`init` / `serve` / `new-project` / `migrate`); the
scaffolder never reimplements collector logic and has **no runtime dependencies**.

## Canonical usage

```bash
npm create uptimizr@latest my-analytics
# pick the engine + project name up front:
npm create uptimizr@latest my-analytics -- --engine three --name "My Game"
# the full suite (collector + dashboard + runnable demo):
npm create uptimizr@latest my-analytics -- --full
# an external database instead of DuckDB:
npm create uptimizr@latest my-analytics -- --store postgres
```

Then:

```bash
cd my-analytics
npm install
npm run setup     # uptimizr init — mints your first project + owner API key (printed once)
npm start         # uptimizr serve — ingestion + query API on http://localhost:4318
```

## Flags and prompts

| Flag             | Default              | Meaning                                                            |
| ---------------- | -------------------- | ------------------------------------------------------------------ |
| `[dir]`          | `uptimizr-analytics` | Folder to create.                                                  |
| `--engine <e>`   | `babylon`            | `babylon`, `babylon-lite`, `three`, `r3f`, `playcanvas`, `aframe`. |
| `--store <s>`    | `duckdb`             | `duckdb`, `postgres`, `clickhouse`, `mssql`.                       |
| `--name <name>`  | folder name          | Human-readable project name.                                       |
| `--port <n>`     | `4318`               | Collector port baked into config + snippet.                        |
| `--dashboard`    | off                  | Include the analytics dashboard (`@uptimizr/dashboard`).           |
| `--no-dashboard` | —                    | Set dashboard inclusion off.                                       |
| `--demo`         | off                  | Include a runnable Babylon demo scene.                             |
| `--no-demo`      | —                    | Set demo inclusion off.                                            |
| `--full`         | off                  | Full suite: collector + dashboard + demo.                          |
| `--minimal`      | —                    | Collector only; skip the interactive prompts.                      |

When **both stdin and stdout are TTYs** and a value is still unset, the scaffolder prompts for it
in order: project folder, engine, collector store, dashboard (y/N), demo (y/N). Any flag you pass
suppresses its prompt, and `--minimal` / `--full` settle both extras so nothing is asked. In a
non-TTY (CI, an agent's shell) **no prompt ever appears** — the defaults apply, so always pass the
flags explicitly when scripting. An unknown `--engine` / `--store` value exits non-zero rather
than falling back.

## What it generates

```
my-analytics/
  package.json          # scripts wired to the `uptimizr` CLI (+ the chosen store package)
  .env                  # generated visitor-hash secret + store config (git-ignored)
  .gitignore
  README.md
  client-snippet.<engine>.ts   # paste-ready connector wiring for your app
  demo/                 # (--demo) a runnable Babylon scene + a tiny static server
  data/                 # (DuckDB only) the store file lives here
```

With `--dashboard` it adds `@uptimizr/dashboard` and an `npm run dashboard` script (UI on
`http://localhost:3000`) and widens the collector's `COLLECTOR_CORS_ORIGINS` to allow it. With
`--demo` it writes a self-contained Babylon demo scene plus a zero-dependency static server and an
`npm run demo` script (`http://localhost:5173`) — the demo always uses Babylon, the reference
connector, regardless of `--engine`.

For a non-DuckDB store, the scaffold adds the store package to `package.json`, writes
**placeholder** local-server connection settings you edit to match your database, and skips
`data/`. Start the database first; `npm run setup` then creates the schema and mints the first
project + API key there, because the `uptimizr` CLI honours `COLLECTOR_STORE` for `init` /
`new-project` / `migrate` exactly as it does for `serve`.

## Rules for agents

- **Only write files.** Never add collector logic, a database driver, or a runtime dependency —
  this package must stay dependency-free and instantly `npx`-able.
- The generated `.env` holds a freshly generated `VISITOR_HASH_SECRET` and is **git-ignored**.
  Never commit a generated `.env`, and never place a real connection string or API key in a
  template — external-store settings are local-server placeholders by design.
- The API key is minted by `npm run setup` (`uptimizr init`) and printed **once**; the scaffolder
  never creates or stores one. It is the operator's **owner** key — `query`, `query:raw` and
  `annotate` — so the dashboard, replay, live follow and scene regions all work off it. Agents and
  MCP clients get a narrower `query` key from `uptimizr new-key`.
- Keep the generated scripts thin wrappers over the `uptimizr` CLI. A new collector capability is a
  CLI change, not a scaffolder change.
- Store choices must stay in step with the collector's `COLLECTOR_STORE` values
  (`duckdb` | `postgres` | `mssql` | `clickhouse`).
- **This package is released manually.** It is unscoped and listed under `ignore` in
  `.changeset/config.json`, so `changeset publish` never versions or publishes it — bump its
  `package.json` version by hand and `npm publish` from an account with rights. Do **not** add it
  to a changeset: an ignored package in a changeset fails `changeset version`. See
  [CONTRIBUTING.md](https://github.com/RaananW/Uptimizr/blob/main/CONTRIBUTING.md).

## More

- Package reference: [README.md](./README.md)
- Collector CLI: [`@uptimizr/collector-server`](../../apps/collector-server/AGENTS.md)
- Quickstart: https://uptimizr.com/docs/quickstart/
- Deploy guide: https://uptimizr.com/docs/deploy/collector/
