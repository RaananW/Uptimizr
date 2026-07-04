---
"@uptimizr/db": minor
"@uptimizr/react": minor
---

feat(db,react): variant → conversion leaderboard for product configurators (#150)

Add a read-only leaderboard that ranks `custom` variant events (grouped by their
`name`) by views, with distinct sessions, mean dwell before the next variant
switch/conversion, and an optional per-variant conversion rate to a caller-supplied
success event. Reuses the ADR 0038 funnel-step predicate shape — no schema change.

- `@uptimizr/db`: `buildVariantLeaderboard` query builder (`VariantLeaderboardOptions`
  / `VariantLeaderboardRow`), engine-agnostic so DuckDB and ClickHouse match.
- `@uptimizr/react`: `CollectorApi.variantLeaderboard()` client method and a new
  `variant-leaderboard` dashboard panel with an in-panel success-event picker.

Also wires the `GET /api/v1/variant-leaderboard` endpoint through the collector
server (store contract + DuckDB / ClickHouse / memory stores).
