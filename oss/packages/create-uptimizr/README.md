# create-uptimizr

Scaffold a **Docker-free, single-file (DuckDB)** self-host of the Uptimizr OSS
3D-analytics collector in one command.

```bash
npm create uptimizr@latest my-analytics
# or pick the engine + name up front:
npm create uptimizr@latest my-analytics -- --engine three --name "My Game"
```

It generates a ready-to-run folder:

```
my-analytics/
  package.json          # scripts wired to the `uptimizr` CLI
  .env                  # generated visitor-hash secret + DuckDB config (git-ignored)
  .gitignore
  README.md
  client-snippet.<engine>.ts   # paste-ready connector wiring for your app
  data/                 # the DuckDB store lives here
```

Then:

```bash
cd my-analytics
npm install
npm run setup     # mints your first project + API key (printed once)
npm start         # ingestion + query API on http://localhost:4318
```

## Options

| Flag            | Default              | Description                                                        |
| --------------- | -------------------- | ------------------------------------------------------------------ |
| `[dir]`         | `uptimizr-analytics` | Folder to create (prompted when interactive).                      |
| `--engine <e>`  | `babylon`            | `babylon`, `babylon-lite`, `three`, `r3f`, `playcanvas`, `aframe`. |
| `--name <name>` | folder name          | Human-readable project name.                                       |
| `--port <n>`    | `4318`               | Collector port baked into config + snippet.                        |

The scaffolder only writes files — the generated folder is operated entirely via
the [`uptimizr` CLI](../../apps/collector-server#readme) (`init` / `serve` /
`new-project` / `migrate`); it never reimplements collector logic.
