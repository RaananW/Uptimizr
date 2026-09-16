# ADR 0051: AI-first analytics layer (semantic registry, insight primitives, agent autonomy)

- **Status:** Accepted (amended 2026-09-16 — see [Amendment](#amendment-2026-09-16-the-registry-ships-as-uptimizrmetrics))
- **Date:** 2026-09-15
- **Deciders:** RaananW
- **Extends:** [ADR 0017](./0017-consumer-facing-agents.md) (consumer-facing agent strategy),
  [ADR 0050](./0050-in-browser-analytics-assistant.md) (in-browser assistant, shared tool contract)
- **Amends:** ADR 0017 / ADR 0050 — the "strictly read-only" agent surface is narrowed to
  **events are read-only**; a scoped **metadata** write path is introduced (§5, §7).

## Context

ADR 0017 and ADR 0050 gave Uptimizr a working agent surface: a shared read-only tool catalog in
`@uptimizr/agent-core`, the `@uptimizr/mcp` stdio server, packaged `AGENTS.md` / `llms.txt`, and a
client-side assistant in `@uptimizr/react`. The trust model they fixed — self-hosted, no
Uptimizr-operated agent, aggregate-only by default, raw per-session events gated behind
`ENABLE_RAW_SESSION_RETENTION` (ADR 0003) — is right and is kept here.

What that surface does **not** do is make the data easy for an agent to _understand_, and it
exposes only a fraction of what the collector can answer:

1. **Coverage.** The collector serves ~70 read endpoints backed by 68 aggregations in
   `@uptimizr/db` (`query/aggregations.ts`). The hand-written catalog exposes 20 tools. Dead and
   rage clicks, jank, perf-by-device, coverage, blind spots, scene retention, the variant
   leaderboard and the load→bounce funnel are all invisible to agents. Every new endpoint needs a
   parallel, manual catalog edit — the exact drift ADR 0017 warned about.
2. **No semantics.** Tools carry input schemas but no output row schema, unit, grain, dimensions,
   caveats, or interpretation notes. The `uptimizr://capabilities` resource lists tool and parameter
   names only. An agent must guess what a row means, whether a count is a string (the ClickHouse
   pitfall in the `query-analytics` skill) and whether a sample is large enough to trust.
3. **Token-hostile shapes.** A 500-bin heatmap, a voxel cloud, or a desire-line path is the wrong
   representation for a language model. There is no summary mode, and spatial results are
   coordinates with no way to name _what_ is at a hotspot even though the scene registry
   (ADR 0014) already stores labels, bounds and proxy geometry.
4. **Pull only, model-dependent reasoning.** Every insight — "what changed since last week", "is
   this FPS drop significant", "which scene is unhealthy" — must be re-derived by the model from raw
   aggregate rows on every question. Small in-browser models (ADR 0050 §4) do this poorly; hosted
   models do it expensively. The live bus (ADR 0032) fans out every ingested event, but nothing lets
   an agent subscribe to a _condition_ or run on a schedule.
5. **Stateless.** The assistant has a fixed system prompt, no per-project context (scene labels,
   custom-event vocabulary, funnel definitions, what capture channels are on), no memory, and no
   way to leave anything behind — an annotation, a saved analysis, a panel.

The forces: the storage seam (ADR 0020) must stay clean; backends stay thin (ADR 0005); events
live once in `@uptimizr/schema`; the privacy model (ADR 0003) is non-negotiable; and everything
must work for a self-hoster on a single DuckDB file with no Uptimizr-operated service.

## Decision

Treat **agents as the primary consumer of the analytics data**, alongside the dashboard, and build
an **AI-first analytics layer** in the OSS collector and packages. It has seven pillars, delivered in
three stages (§8). The trust boundary of ADR 0017/0050 is preserved with one deliberate, scoped
relaxation (§5, §7): agents may write **project metadata** (never events) under a dedicated key
capability.

### 1. Semantic metric registry — generated, not hand-written

A single **metric registry** in `@uptimizr/db` (next to the aggregations it describes) declares,
for every aggregation: `name`, `description`, `unit`, `grain`, `dimensions`, accepted `filters`,
the **output row schema** (Zod), `caveats` (e.g. minimum sample size, sampling-rate sensitivity),
`interpretation` notes, and `related` metrics.

Everything downstream is **derived** from the registry, never maintained by hand:

- the `readTools` catalog in `@uptimizr/agent-core` (one tool per registry entry — coverage becomes
  68/68 mechanically),
- an **OpenAPI** document served by the collector (`GET /api/v1/openapi.json`),
- the MCP `uptimizr://capabilities` resource, which becomes the full registry,
- the query table in `docs/integration.md` and the docs site `api/query` page,
- the packaged `AGENTS.md` / `llms.txt` tool sections.

A CI test asserts that every `build*` aggregation has a registry entry and that every registered
endpoint's Zod querystring matches the registry's declared filters. Adding an aggregation without a
registry entry fails the build.

### 2. Agent-shaped results

Every aggregate endpoint accepts `format=full | table | summary` (default `full`, unchanged for
the dashboard).

- **`summary`** returns top-_k_ clusters/rows with share-of-total, the sample size, a confidence
  band where the registry defines one, and a one-line textual reading. Output is bounded (a
  registry-declared `maxSummaryRows`), so a summary is always safe to put in a model context.
- **Spatial labelling.** Spatial results (world/gaze/position/click-ray heatmaps, paths,
  trajectories) are resolved against the scene registry: each cluster carries `nearestMesh`,
  `region` and `distance`. The scene registry gains developer-named **regions** (labelled AABBs
  per scene, ADR 0014 extension) so agents and humans share vocabulary — "the entrance", not
  `[-3.1, 0, 4.2]`.
- **Numbers are numbers.** The collector coerces dialect string-encoded aggregates to JSON numbers
  at the edge for every store, removing the ClickHouse pitfall from every client.

### 3. Composable query primitives (a bounded DSL)

Rather than growing the canned-endpoint surface indefinitely, add one validated **analytics query
DSL** over the event model, served at `POST /api/v1/query` and exposed as a single `query` tool:

```json
{
  "metric": "mesh_interactions",
  "dimensions": ["mesh", "source"],
  "filters": { "scene": "lobby", "cameraMode": "first-person" },
  "range": { "since": 1757000000000, "until": 1757600000000 },
  "segment": { "device.os": "iOS" },
  "compare": { "range": { "since": 1756400000000, "until": 1757000000000 } },
  "format": "summary"
}
```

- The DSL is **closed**: metrics, dimensions and filters are exactly the registry's vocabulary
  (§1), validated by Zod at the edge. There is no raw SQL, no free-form expression, and output is
  bounded. It compiles through the existing dialect layer (`@uptimizr/db` `query/*Dialect.ts`), so
  the storage seam (ADR 0020) is untouched and parity tests cover it like any aggregation.
- Three operations ride on it and are what agents most lack today: **compare** (two ranges or two
  segments, returning deltas and, where defined, significance), **explain** (the compiled plan,
  row counts scanned, and sample-size warnings, so an agent can judge trust), and **drill** (from a
  summary cluster into a region, mesh, scene or segment).
- The funnel step predicates of ADR 0038 are folded in as the DSL's filter grammar; funnel,
  scene-retention and load→bounce remain available as canned endpoints too.

### 4. Server-side insight primitives — deterministic, model-free

The collector computes the statistics so the model does not have to. New read endpoints (and
registry entries, hence tools) under `/api/v1/insights/*`:

- **`baseline`** — per metric/scene: rolling mean, p50/p90 and variance over a reference window.
- **`movers`** — top movers versus a reference period across every registry metric that declares
  itself comparable, ranked by magnitude and significance.
- **`anomalies`** — change-point / outlier detection on any registry time series (event volume,
  FPS, jank, error rate, XR abandonment), returning windows with scores and the contributing
  dimension when one dominates.
- **`significance`** — a two-sample test for variant / segment comparisons (feeds the variant
  leaderboard and the DSL `compare`).
- **`scene-health`** — a composite score per scene with its contributing factors (perf stability,
  error rate, dead/rage clicks, coverage, XR comfort), each factor traceable to the metric behind
  it.

These are ordinary aggregations: dialect-authored, parity-tested, aggregate-only, privacy-safe.
Because they are deterministic, a 1–3B local model (ADR 0050) can produce a correct weekly review
by _reading_ them rather than by re-deriving statistics from raw bins.

### 5. Project context and agent memory

- **Project context resource.** The collector serves `GET /api/v1/context` (and MCP
  `uptimizr://context`): scene labels and regions, the **discovered custom-event vocabulary**
  (distinct `custom.name` values with their observed prop keys and types — one new aggregation),
  funnel and segment definitions, which capture channels are enabled at what sampling rate
  (ADR 0012), retention flags (ADR 0003), the store engine, and the data-quality state (last event
  seen, sessions in the last 24 h). The assistant injects it into the system prompt; MCP clients
  read it first.
- **Metadata write path (the scoped relaxation).** A small, project-scoped store for
  **annotations** (a note pinned to a metric, scene, mesh, region or time window), **saved
  analyses** (a DSL query plus the agent's conclusion), a **glossary** ("`btn_01` is the buy
  button") and **panel specs** (§7). These are metadata rows in the metadata tables (ADR 0020), not
  events: `@uptimizr/schema` is untouched, events remain append-only and read-only. Writes require
  the `annotate` capability (§7) and are exposed as MCP tools and assistant actions.

### 6. Push, schedules and outbound actions

- **Conditional subscriptions** on the live bus (ADR 0032): a subscriber declares a registry metric,
  a window and a predicate (threshold crossing, `anomalies` fired, error spike, new scene seen,
  XR discomfort above a rate). The collector evaluates them in-process on the same fan-out path.
- **Delivery** over SSE for connected agents (`GET /api/v1/subscriptions/:id/stream`) and over
  **webhooks** (signed POST) for automation — Slack, GitHub issues, or a self-hoster's own agent.
- **Scheduled reports.** A `uptimizr agent report` CLI (in `collector-server`, ADR 0029) runs the
  headless `runAgent` loop from `@uptimizr/agent-core` against the local collector with the
  self-hoster's own provider configuration, on a cron or on demand, and delivers via webhook or
  file. It runs **inside the self-hoster's process** — Uptimizr operates nothing, consistent with
  ADR 0017. The weekly scene-health digest is the first consumer.

### 7. Reach, identity and artifacts

- **Collector-hosted MCP transport.** The collector serves MCP over **Streamable HTTP** at `/mcp`,
  reusing `@uptimizr/mcp`'s server construction. Any remote agent connects with an API key and no
  `npx` step. This resolves the transport deferred in ADR 0050 §7; the auth it required is the
  key model below. The stdio package remains for local clients.
- **Agent-scoped keys.** The `ApiKeyCapability` model in `@uptimizr/db` grows from
  `ingest | query` to `ingest | query | annotate | query:raw`. `annotate` unlocks §5 metadata
  writes; `query:raw` is only honoured when `ENABLE_RAW_SESSION_RETENTION` is on and grants the
  per-session event stream plus a derived **session narrative** (an ordered, compacted account of
  what one session did) — never by default, never on a plain `query` key. Keys carry per-key rate
  limits, and every agent request is written to an **audit log** (key id, tool/endpoint, params,
  row count, duration) queryable by the project owner.
- **Agent-authored panels, declaratively.** A `PanelSpec` JSON (DSL query + a chart kind from a
  fixed set + layout hints) is a metadata row (§5) that the dashboard renders through the existing
  `PanelDefinition` contract (ADR 0036/0039) with a generic "spec panel" definition. "Pin this
  answer as a panel" therefore ships **no remote code** — the trust decision of ADR 0041 is not
  widened.
- **Packaged skills.** Alongside MCP prompts, ship methodology **skills** (conversion
  investigation, XR comfort audit, performance-regression triage, weekly scene health) that name
  the registry metrics, insight primitives and DSL patterns to use, in the packaged `AGENTS.md`
  tree of `@uptimizr/mcp` and `@uptimizr/agent-core`.

### 8. Sequencing and the evaluation harness

Three stages, each shippable on its own; the harness lands with stage 1 and gates every stage.

| Stage             | Delivers                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Foundation** | Metric registry; generated catalog, OpenAPI, capabilities, docs; output schemas; `format=summary`; numeric coercion; evaluation harness (§1, §2 partial).              |
| **2. Reasoning**  | Scene regions + spatial labelling; the query DSL with `compare` / `explain` / `drill`; insight primitives; project context resource; custom-event vocabulary (§2–§5).  |
| **3. Autonomy**   | Conditional subscriptions + webhooks; `uptimizr agent report`; collector-hosted MCP transport; agent-scoped keys + audit log; annotations/memory; spec panels (§5–§7). |

**Evaluation harness.** A question bank with expected answers, run against the seeded parity
fixtures (`@uptimizr/db` `parity/fixtures.ts`) through `runAgent` with a hosted provider and the
curated local models, in CI (hosted provider behind a secret; local model on a scheduled job). It
measures tool selection, argument correctness and answer accuracy, and is the instrument for tuning
registry descriptions and skills. "AI-first" is a measured property, not a claim.

### 9. Trust boundary (restated)

- **Events are read-only.** No agent surface ingests, mutates or deletes events. Unchanged.
- **Aggregate by default.** Raw per-session data is reachable only through `query:raw` on a
  retention-enabled collector (ADR 0003). Insight primitives, summaries and the DSL are aggregate.
- **No Uptimizr-operated agent or egress.** Everything runs in the self-hoster's collector or the
  user's browser with the user's chosen provider (ADR 0017, ADR 0050).
- **Metadata writes are scoped and audited.** `annotate` writes metadata rows only, in the
  project the key belongs to, and appear in the audit log.
- **Bounded outputs.** Summaries, DSL results and subscriptions all carry registry-declared caps;
  no endpoint can be asked for an unbounded payload.

### Scope note

This ADR records the strategy, the trust-model amendment and the stage order. A mutable
[design sketch](../phases/ai-first-analytics-layer-design.md) under `docs/phases` holds the registry shape, DSL grammar, insight algorithms and
subscription predicate format while they are refined; discrete work is tracked as GitHub issues
under the **Agentic experience** milestone (ADR 0016). Every shipped piece updates the public docs
site and `docs/integration.md` (AGENTS.md golden rule 8).

## Consequences

### Positive

- **Full, drift-proof coverage.** Agents see every aggregation the collector can compute, and the
  catalog, OpenAPI, resources and docs cannot diverge because all are generated from one registry.
- **Meaning travels with the data.** Units, grain, caveats, sample sizes and scene labels make
  results interpretable by small local models and cheap for hosted ones.
- **Insights are cheap and reproducible.** Baselines, movers, anomalies and health scores are
  deterministic server aggregations — the same answer for every agent, testable in parity suites.
- **Agents can act, not only answer.** Subscriptions, scheduled reports, annotations and spec
  panels turn one-off chats into durable outcomes inside the self-hoster's stack.
- **Reach without a hosted service.** Collector-hosted MCP over HTTP with scoped keys serves remote
  agents while keeping every guarantee of ADR 0017.
- **Measured quality.** The evaluation harness makes regressions in agent usefulness visible in CI.

### Negative / trade-offs

- **A larger surface to secure.** New write path (metadata), new transport (HTTP MCP), new keys,
  webhooks. Mitigated by capability scoping, audit logging, signed webhooks and bounded outputs.
- **The DSL is a commitment.** A closed grammar must evolve with the registry; a breaking change is
  a versioned contract change. Mitigated by deriving the vocabulary from the registry rather than
  duplicating it.
- **Insight algorithms need per-store parity.** Anomaly and significance computations must be
  authored in dialect-portable SQL (or computed in the collector from portable aggregates) across
  DuckDB, Postgres, SQL Server and ClickHouse. Some may land collector-side first.
- **Registry authoring is real work.** 68 entries with units, caveats and output schemas. Mitigated
  by generating the skeleton from existing Zod querystrings and row types, then curating.
- **The evaluation harness costs CI time and a provider secret.** Hosted runs gate PRs cheaply;
  local-model runs are scheduled, not per-PR.

## Alternatives considered

- **Keep hand-writing tools for more endpoints** — closes today's gap once, reopens it with the
  next endpoint, and still ships no semantics. Rejected.
- **Expose raw SQL (or a SQL-like language) to agents** — maximal flexibility, but unbounded
  output, injection surface, per-dialect divergence and a leak past the aggregate-only boundary.
  Rejected in favour of a closed, registry-derived DSL.
- **Let the model do the statistics** — no server work, but unreliable on small models and
  re-computed on every question. Rejected; deterministic primitives are cheaper and testable.
- **A hosted Uptimizr insight service** — would centralise anomaly detection and reports. Rejected
  again per ADR 0017: data egress under Uptimizr's control breaks the self-hosted model.
- **Keep the surface strictly read-only** — avoids the new write path, but leaves agents unable to
  annotate, save or pin anything, and pushes memory into each client. Rejected; metadata-only writes
  under a scoped key keep events immutable.
- **Agent-authored panels as remote modules** — reuses ADR 0041 loading, but executes
  model-generated code with dashboard privileges. Rejected; declarative specs only.
- **A separate `@uptimizr/insights` service** — cleaner separation, but a second process for
  self-hosters and a second gateway to the data. Rejected; insight primitives are aggregations in
  the collector behind the same auth.

## Amendment (2026-09-16): the registry ships as `@uptimizr/metrics`

§1 places the metric registry "in `@uptimizr/db` (next to the aggregations it describes)", served
on a dependency-free `@uptimizr/db/registry` subpath. A pure _subpath_ turned out not to be enough:
a package manager installs a package's **dependencies**, not the subset a subpath reaches, so
`@uptimizr/agent-core` and `@uptimizr/mcp` — which read the registry — dragged
`@uptimizr/db` → `@duckdb/node-api` (~37 MB of native binding) into every install of
`@uptimizr/react` and every `npx @uptimizr/mcp`. Neither can load a DuckDB driver.

The registry therefore moves to its **own published package**, `@uptimizr/metrics`
(`oss/packages/metrics`, Apache-2.0), whose only runtime dependencies are `zod` and
`@uptimizr/schema`. `@uptimizr/db` depends on it; `@uptimizr/agent-core` and `@uptimizr/mcp`
depend on it _instead of_ `@uptimizr/db`. The `@uptimizr/db/registry` subpath is removed (it was
never released). Every export keeps its name.

One consequence: the registry can no longer derive the builder-name union with
`keyof typeof aggregations` (that would re-create the cycle). `AGGREGATION_BUILDER_NAMES` is
declared as literal data in `@uptimizr/metrics`, and `@uptimizr/db`'s `registry.test.ts` asserts
at runtime that it equals the set of `build*` exports — the invariant moves from the compiler to
CI, but it is still enforced on every build.
