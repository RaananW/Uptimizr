---
"@uptimizr/schema": minor
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/react": minor
---

feat: caller-configured conversion-funnel aggregation (#78).

Implements sub-issue (b) of the funnel epic in OSS. Authoring, persistence, and the
saved-funnel dashboard panel remain hosted-only — the OSS dashboard stays a passive
viewer (ADR 0038).

- `@uptimizr/schema`: shared funnel contract — `funnelStepSchema`, `funnelStepsSchema`
  (2–20 steps), `funnelConfigSchema`, and `FUNNEL_CONFIG_VERSION`.
- `@uptimizr/db`: new dialect-agnostic builder `buildFunnel` — a dynamic-N CTE chain
  using only `JOIN`/`min`/`GROUP BY` (no window or `ASOF` functions) so DuckDB and
  ClickHouse render identically (golden parity coverage on DuckDB). Semantics are
  sequential, first-touch, and monotonic.
- `@uptimizr/collector-server`: new read endpoint `GET /api/v1/funnel`, wired through
  every store. The funnel definition is supplied per request as a `steps` JSON array
  (validated against `funnelStepsSchema`) and never stored.
- `@uptimizr/react`: new client method `funnel(steps, params?)`.
