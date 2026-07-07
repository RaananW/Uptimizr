---
"@uptimizr/db": patch
---

fix(db): make `buildSceneRetention` and `buildVariantLeaderboard` run on stock ClickHouse

Both builders previously emitted an `INNER JOIN … ON` whose condition mixed a
left and a right column in an inequality (matching a row to the session's next
event). DuckDB accepts that, but ClickHouse rejects it unless the session sets
`allow_experimental_join_condition = 1`.

The scene-retention builder now uses an `ASOF INNER JOIN` (equality + one
inequality — natively supported by ClickHouse) to find each marker's nearest
following scene, and the variant-leaderboard builder keeps every join keyed on
`session_id` alone, moving the ordered / relative guards into `WHERE`. Output
row shapes and results are unchanged on both engines.

Downstream consumers that scoped `allow_experimental_join_condition` around
these two reads (e.g. a hosted `panelQuerySettings` shim) can drop that
workaround after upgrading — the generated SQL runs on managed/stock ClickHouse
with default settings.
