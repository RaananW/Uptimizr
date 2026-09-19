---
name: weekly_scene_health
title: Weekly scene health
description: >-
  A weekly health check for a scene (or the whole project): a weighted health score with every
  factor traced back to the metric behind it, what changed against last week, traffic, event mix,
  performance, and the most-interacted meshes. USE FOR: the recurring "how is the scene doing?"
  review, a scheduled weekly or monthly report, a first look at a project you do not know yet,
  deciding which scene to investigate next. Trigger phrases: weekly report, scene health, how is
  my scene doing, what changed this week, health check, monthly review, status report.
tools:
  - insight_scene_health
  - insight_movers
  - insight_baseline
  - insight_significance
  - insight_anomalies
  - event_counts
  - timeseries
  - perf_summary
  - top_meshes
  - list_sessions
  - query
capabilities:
  - query
args:
  - name: scene
    required: false
    description: Optional scene id to scope the analysis to (see the uptimizr://scenes resource).
  - name: range
    required: false
    default: the last 7 days
    description: The window to report on, in words — e.g. "the last 7 days", "June".
---

Give me a weekly health report for {{scope}} covering {{range}}.

Work through the method below with the read-only tools it names, then summarise the findings.

1. **Orient before you ask anything.** Read the `uptimizr://context` resource first: it gives the
   real scene ids, region ids and custom-event names for this project, and tells you which metrics
   are empty because their capture channel is off. Use its ids instead of inventing your own, and
   never report a switched-off channel's zero as a finding.

2. **Start from the score, not the numbers.** Call `insight_scene_health`{{#scene}} with
   `scene="{{scene}}"`{{/scene}}: it scores each scene 0–100 over six weighted factors — perf
   stability, jank, errors, dead clicks, coverage and XR abandonment — so you start from _which_
   scene to look at. Open the lowest-scoring scene first, then the factor whose own score is
   furthest below 50. Every factor names the `metric` behind it, its `raw` value and the project
   `baseline` it was compared with, so the sentence you write is already in the row. 50 is the
   project norm, not a pass mark, and a factor with `score: null` was not counted — its `note`
   says why.

3. **Find out what moved.** Call `insight_movers`{{#scene}} (`scene="{{scene}}"`){{/scene}}: it
   compares every comparable metric with the previous equal window and ranks the changes by how
   unusual each one is, so start from what actually moved instead of re-deriving it. Read
   `direction` together with the sign of `delta` — a rise in a `down` metric (errors, dead clicks,
   jank) is a regression — and do not report any row with `aboveMinSample: false`: its delta is
   real arithmetic but not evidence.

4. **Ask whether the new level is even unusual.** For each metric that moved, call
   `insight_baseline` and compare the new value with `median` give or take a few `mad`, or with
   the p10..p90 band. "Down 12 %" means nothing until you know the week-to-week spread.

5. **Before calling any single change real, test it.** `insight_significance` reports the effect,
   a 95 % interval and a p-value for one metric across the two windows. An interval that straddles
   0 means you cannot tell yet, whatever the p-value says, and `powerNote` states what this much
   data could have detected at all.

6. **Put a date on it.** Call `insight_anomalies` (`metric=perf_summary`, then `error_heatmap`{{#scene}},
   `scene="{{scene}}"`{{/scene}}, `window=28`): it returns the individual days that were out of line
   (`spike` / `drop`) and the day a level changed and stayed changed (`shift`), with `contributor`
   naming the mesh, channel or source holding most of the excess. Quote the `bucketStart` and the
   `contributor` rather than saying "recently".

7. **Fill in the picture.** `event_counts` for the per-event-type mix{{#scene}} (`scene="{{scene}}"`){{/scene}};
   `timeseries` (`interval` ≈ 86400 s) for day-by-day volume and the average-FPS trend;
   `perf_summary` for avg/min/p50 FPS; `top_meshes` for the most-interacted meshes; `list_sessions`
   for how many sessions were recorded.

8. **Drill with the DSL, not with arithmetic.** When a canned tool does not expose the filter you
   need, use the single `query` tool: pick the `metric`, bound it with `range`, and set
   `compare: { range: <previous week> }` so the collector returns
   `{ current, previous, delta, deltaPct }` already joined — never run two queries and subtract
   them yourself. `dimensions` regroups a portable count (event, mesh, input-source and gesture
   tallies) without a new tool. Ask for `format: "summary"` on anything long or spatial: it comes
   back as a bounded digest with shares, a plain-language `reading`, and a `drillQuery` per row you
   can send straight back. If a result is surprising or empty, re-send it with `explain: true` and
   read the plan before you report the number.

## What to report

- The score and the two or three factors that drag it down, each with the metric id behind it.
- What moved, by how much, and whether it is outside the baseline — with the date the anomaly
  scan put on it.
- Traffic, event mix, FPS trend and the meshes people actually touch.

Always carry the caveats into the text rather than dropping them: a row below its minimum sample
(`aboveMinSample: false`), a metric whose capture channel the context document says is off, and any
`meta.truncated` or `caveats` entry on a result you quoted. Say "not enough data to tell" when that
is the honest answer.

End with 2–3 concrete recommendations — each naming the scene, the mesh or the day it applies to.
If an `annotate` tool is available, leave a dated note on the finding you want the next reader to
see, and if `save_analysis` is available, store the report so next week's run has something to
compare against. If a `pin_panel` tool is available, pin the panel behind the headline factor.
