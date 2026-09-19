---
"@uptimizr/metrics": minor
"@uptimizr/db": minor
"@uptimizr/collector-server": minor
"@uptimizr/agent-core": minor
"@uptimizr/mcp": minor
"@uptimizr/react": minor
---

Insight primitives: `significance` and `scene_health` (ADR 0051 §4)

Two more registry metrics under `/api/v1/insights/`, completing the Stage 2 set:

- **`insight_significance`** (`GET /api/v1/insights/significance`) — is that
  difference real? Compares one comparable metric across two windows and reports
  `{ a, b, effect, ci95, p, test, effectUnit, significant, powerNote }`, with the
  test **chosen from what the measure is**: a two-proportion z with Wilson intervals
  and a Newcombe hybrid-score interval on the difference when the metric's headline
  column declares a `rateOf` denominator, an exact Poisson rate test (conditional
  binomial) for a bare count, and Welch's t over the per-bucket values for a level or
  a summed quantity. Welch counts **buckets**, not events, because samples inside one
  day are not independent. `powerNote` states the smallest difference these sample
  sizes could have detected at 80% power, so "no effect" stays distinguishable from
  "not enough data".
- **`insight_scene_health`** (`GET /api/v1/insights/scene-health`) — which scene is in
  trouble, and why? One 0-100 score per scene over six weighted factors — perf
  stability (p05 FPS), jank rate, error rate, dead-click rate, exploration coverage
  and XR abandonment — each normalised against the **project's own baseline over the
  preceding equal window**, so 50 is the project norm rather than a pass mark. Every
  factor reports the metric id behind it, its raw value, the baseline it was compared
  with and the weight it carried, so the score can always be taken apart. Weights are
  declared in the registry entry (and so appear in `capabilities`) and are overridable
  per request with `weights`.

Both are ordinary registry entries, so they arrive as agent and MCP tools, in the
generated OpenAPI document and in the capabilities resource automatically, and they
accept `format=table | summary`. Every statistic — p-values, confidence intervals and
the health score alike — is computed in **pure TypeScript** over the same portable
per-bucket query, so no two storage engines can disagree about one.

`@uptimizr/db` additionally exports the statistics themselves (`twoProportionTest`,
`welchTest`, `poissonRateTest`, `newcombeDifferenceInterval`, `wilsonBounds`,
`studentTwoSidedP`, `binomialCdf`, `normalCdf`) so a caller that needs one of these
tests outside the insight endpoints does not have to reimplement it.

`@uptimizr/react` gains a **Scene health score** tile in the OSS panel catalog
(`sceneHealthScorePanel` / `SceneHealthScoreView`) and `CollectorApi.sceneHealth()`.
Each factor bar names the metric behind it, so the tile routes rather than dead-ends.
The existing `scene-health` panel (raw event counts for the selected window) is
unchanged.

The `weekly_scene_health` MCP prompt now leads with `insight_scene_health`, then
`insight_movers`, and tells the agent to confirm any single change with
`insight_significance` before reporting it.

`insight_significance` compares two **time windows** in v1. A segment-versus-segment
contrast (variant A vs variant B) needs the bucket series split by a promoted
dimension and returns `400` naming the window parameters rather than answering the
wrong comparison.
