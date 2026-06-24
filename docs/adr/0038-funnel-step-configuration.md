# ADR 0038: Configured/authored analytics are hosted-only; OSS computes funnels from request-supplied steps

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Uptimizr maintainers

## Context

Issue #78 ("single-project configurator funnel") asks for conversion funnels: a
project owner defines an ordered sequence of in-scene milestones — _opened the
scene → orbited the camera → clicked the product_ — and the dashboard shows how
many sessions reach each step and where they drop off.

A funnel has two distinct halves:

1. **Authoring/configuration** — a human picks the steps, names them, saves the
   definition, and pins it to a dashboard panel. This implies a logged-in user, a
   place to persist the definition per project, and an editor UI.
2. **Aggregation** — given a set of step predicates, count how many sessions reach
   each step. This is pure read-only math over the existing `events` table.

The OSS collector + dashboard are, by design, a **passive data viewer** (ADR 0003,
ADR 0004, ADR 0020). There is no end-user authentication, no human-authored
configuration surface, and no per-user state: projects and API keys are
CLI-provisioned, scene proxies are SDK-written, and every query route is a
read-only `GET`. Nothing in OSS lets a person create and save a configuration.
"Events live once" and "keep backends thin" (AGENTS.md) also argue against bolting
an authoring/persistence layer onto the collector.

Open-core principle (ADR 0020): **features are not the differentiator; scale,
concurrency, and multi-tenancy are.** So funnels are not withheld from OSS because
they are "advanced" — only the half that needs an authoring/identity surface
belongs in the hosted product. The aggregation half has no such dependency.

## Decision

Split #78 along the authoring/aggregation seam:

- **The aggregation lands in OSS (sub-issue b).** The collector gains a
  dialect-agnostic `buildFunnel` aggregation in `@uptimizr/db` and a read-only
  `GET /api/v1/funnel` endpoint. The funnel definition is **supplied by the caller
  on each request** as a `steps` JSON array (the CLI, a seed script, or the hosted
  product) — it is validated but never stored. A matching `CollectorApi.funnel()`
  client method and docs ship with it.
- **The step contract is shared.** Step/funnel shapes live once in
  `@uptimizr/schema` (`funnelStepSchema`, `funnelStepsSchema`, `funnelConfigSchema`,
  `FUNNEL_CONFIG_VERSION`) so the collector boundary and the future hosted authoring
  UI validate against the same Zod contract.
- **Authoring, persistence, and the saved-funnel panel are hosted-only
  (sub-issues a, c, d).** The step-picker UI, per-project storage of definitions,
  and the dashboard panel that renders a saved funnel move to the hosted backlog.
  The OSS dashboard stays a passive viewer.

**Step predicate (v1).** A step is `{ type (required), name?, mesh?, label? }`.
`type` is the event type; `name` matches a gesture/interaction kind **or** a
custom-event name (the wide `events` table promotes all three onto the `name`
column, see `toEventRow`); `mesh` restricts to one object; `label` is
presentation-only and ignored by SQL. Wildcards, numeric thresholds, and boolean
combinations are explicitly out of scope and would arrive behind a bumped
`FUNNEL_CONFIG_VERSION`.

**Semantics.** Sequential, first-touch, monotonic. Step 0 is a session's first
matching event; a session reaches step _N_ iff it has a step-_N_ match at a
timestamp at or after the first time it reached step _N−1_ (same `session_id`).

**SQL shape.** A dynamic-N **CTE chain** (one level per step, each level
`min(ts)` per session after the prior level's reach time, `UNION ALL` of the
per-level session counts) using only `JOIN` / `min` / `GROUP BY`. No window or
`ASOF` functions, so DuckDB (OSS) and ClickHouse (scale) render identically and
pass the parity harness (ADR 0020).

## Consequences

### Positive

- The useful, swappable half (the math) is in OSS and works on a single embedded
  DuckDB file with no new infrastructure.
- The storage seam stays clean: funnels are pure reads behind the `@uptimizr/db`
  contracts; nothing about funnels is store-specific.
- One source of truth for the step contract; hosted authoring reuses it.
- The OSS dashboard keeps its "no auth, no config" simplicity.

### Negative / trade-offs

- OSS users without the hosted product must pass `steps` themselves (CLI/script);
  there is no in-dashboard builder. Acceptable — that is precisely the
  authoring surface hosted provides.
- Definitions are not persisted in OSS, so there is no "saved funnels" list there.
- The CTE-chain approach trades the brevity of window functions for cross-dialect
  parity.

## Alternatives considered

- **Build the whole funnel (authoring + persistence + panel) in OSS.** Rejected:
  requires end-user auth, per-user/per-project config storage, and an editor — none
  of which the OSS viewer has, and all of which contradict ADR 0003/0004's passive,
  privacy-first posture.
- **Withhold funnels from OSS entirely.** Rejected: violates the open-core
  principle (ADR 0020) — the aggregation is a feature, and features are not the
  paywall; only the authoring/identity surface justifiably is.
- **Free-form SQL endpoint.** Rejected: unsafe, store-specific, and breaks the
  thin-backend and parity rules.
- **Capture-time `funnel_step` event.** Rejected: bakes the funnel definition into
  the SDK at capture time, so steps can't change retroactively and "events live
  once" is violated.
- **Window/`ASOF`-function SQL.** Rejected: cleaner to write but diverges between
  DuckDB and ClickHouse and fails the parity harness.
- **Client-only aggregation in the dashboard.** Rejected: would pull full event
  streams to the browser, leaking raw data and ignoring the store seam.
