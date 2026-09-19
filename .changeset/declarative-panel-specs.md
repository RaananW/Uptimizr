---
"@uptimizr/schema": minor
"@uptimizr/metrics": minor
"@uptimizr/db": minor
"@uptimizr/db-postgres": minor
"@uptimizr/db-mssql": minor
"@uptimizr/db-clickhouse": minor
"@uptimizr/collector-server": minor
"@uptimizr/react": minor
"@uptimizr/dashboard": minor
"@uptimizr/agent-core": minor
"@uptimizr/mcp": minor
---

Declarative panel specs and "Pin as panel" (ADR 0051 §7)

An agent's answer used to disappear when the chat closed. A **panel spec** keeps
it: a title, the query that produced it, how to draw the result, and the one-line
reading that made it worth keeping. The dashboard loads a project's specs on
mount and renders them alongside its built-in panels.

**A panel is data, never code.** ADR 0041 can load a remote panel _module_ at
runtime, and is explicit about the cost: such a module runs with the dashboard's
full privileges, which is why it is off by default and guarded by an origin
allowlist. A panel written by a language model would be exactly that. So a spec
is a closed document — a metric id, a chart name, some column names — and
`specPanel()` draws it with the panel components `@uptimizr/react` already
ships. There is nothing to import and nothing to evaluate; ADR 0041's trust
decision is not widened.

- **`@uptimizr/schema`** — `panelSpecV1Schema` and friends. The spec's `query`
  is a `queryV1` document whose `range` may additionally be the literal
  `"inherit"`, meaning "whatever the dashboard's filter bar currently says". It
  is built by overriding one key of `queryV1Schema` rather than restating the
  grammar, so a filter added to the DSL reaches panel specs in the same commit.
- **`@uptimizr/metrics`** — `validatePanelSpec()` answers the question that
  decides whether a panel will draw anything: does this chart suit the metric's
  grain, and do these encoding columns exist in its result. A `line` over a
  ranking is not a crash — it renders _something_, which somebody reads as a
  trend a week later — so it is refused at pin time with the validator's issue
  codes, naming the charts that would have worked. The compatibility table is
  `PANEL_CHART_RULES`, published in the docs and pinned by a test. Plus a pure
  `suggestChart()`, which never proposes a spec the collector would refuse.
- **`@uptimizr/db`** and the three optional engines — a `panel_specs` table on
  all four stores. Listed **oldest first**, because these are positions in a
  grid rather than a feed, and a spec can be updated in place, keeping its id
  and its original authorship. Bounded at 50 per project: every spec is a query
  the dashboard runs on every load.
- **`@uptimizr/collector-server`** — `GET`/`POST /api/v1/panels` and
  `PUT`/`DELETE /api/v1/panels/:id`. Writes need `annotate`, reads need `query`,
  every write is audited, and a rejected spec answers `400 { error, issues }` —
  the same body a rejected query gets. OpenAPI under a new `panels` tag.
- **`@uptimizr/react`** — `specPanel(spec)` returns an ordinary ADR 0036
  `PanelDefinition` (id `spec:<id>`, the note as its subtitle) whose `load`
  resolves `"inherit"` from the host's active window on every render.
  `loadSpecPanels(api)` mirrors ADR 0041's loader: a spec that cannot be drawn
  is reported and skipped, so one bad row never empties a dashboard. The
  `CollectorApi` gains `query()`, `panels()`, `pinPanel()`, `updatePanel()` and
  `unpinPanel()`.
- **The dashboard** marks each spec panel "Pinned by agents" and offers an unpin
  control to a key that holds `annotate`. ADR 0039's per-panel hide and settings
  work on a spec panel by id, unchanged.
- **The assistant and MCP** — a "Pin as panel" action on any answer that came
  from a `query` tool call, and the `pin_panel`, `list_panels` and `unpin_panel`
  tools, gated on `annotate` like the rest of the metadata catalog.

Migrations are forward-only and idempotent: DuckDB `0048`–`0049`, Postgres
`0020`, SQL Server `0022`–`0023`, ClickHouse `0017`.
