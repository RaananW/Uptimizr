# create-uptimizr

`create-uptimizr` is published manually rather than by Changesets (see
[CONTRIBUTING](../../../CONTRIBUTING.md#create-uptimizr-is-published-manually-not-via-changesets)),
so this file is maintained by hand.

## 2.0.0

### Major Changes

- Scaffolds now target the **2.x collector line**. `@uptimizr/collector-server` and the optional
  `@uptimizr/db-*` store package move from `^1.1.0` / `^1.0.0` to `^2.0.0`, and
  `@uptimizr/dashboard` from `^1.0.0` to `^1.1.2`. A folder scaffolded with 1.x resolved a 1.x
  collector, which predates the whole ADR 0051 agent layer; a fresh project now starts on it.

  What a new project gets out of the box:

  - **MCP-ready collector.** `GET /api/v1/openapi.json` is an unauthenticated, registry-generated
    OpenAPI 3.1 self-description of every query route — the same registry `@uptimizr/mcp` derives
    its tool catalog from, so a desktop AI client or an agent can discover the API without a
    hand-written spec.
  - **Bounded answers.** Every aggregate endpoint accepts `format=full | table | summary`. `full`
    is unchanged and still the default; `summary` returns a digest capped by the metric's own row
    limit, so a 500-bin heatmap costs an agent the same tokens as a 5-bin one.
  - **Capability-scoped API keys**, per-key rate limits, `GET /api/v1/whoami`, and an agent audit
    trail at `GET /api/v1/audit`.
  - **Scene regions** — name places inside a scene and drill spatial queries by `region`.

  **Enabling replay needs a second key.** `npm run setup` (`uptimizr init`) still mints a
  `query`-only key, which covers the dashboard's panels and is also all an agent or MCP client
  needs. In the 2.x collector the replay timeline (`/api/v1/sessions/:id/events`) and the live
  per-session follow require **both** `ENABLE_RAW_SESSION_RETENTION` on the collector _and_ the new
  `query:raw` capability on the key, so mint a dedicated one with
  `uptimizr new-key <projectId> --capabilities query,query:raw`. See
  [API keys and capabilities](https://uptimizr.com/docs/deploy/collector/#api-keys-and-capabilities).

  The generated `README.md` and the post-scaffold "Next steps" output now say this.

### Patch Changes

- The optional demo scene pins `@uptimizr/babylon@1.0.2` (was `1.0.0`) on its esm.sh import map.

## 1.1.0

- Added the `--store` flag (`duckdb` / `postgres` / `clickhouse` / `mssql`) with matching `.env`,
  store package and README notes, alongside the `--dashboard`, `--demo`, `--full` and `--minimal`
  extras.

## 1.0.0

- Bumped alongside the stable 1.0.0 `@uptimizr/*` line; the scaffolded dependency pins moved to
  `^1.0.0`. Versions before this one predate this file.
