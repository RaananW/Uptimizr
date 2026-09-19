---
name: performance_regression_triage
title: Performance regression triage
description: >-
  Triage a frame-rate or stability regression: confirm it moved, date it, locate it (which scene,
  device class, place in the scene), and name the mechanism — jank, shader compile stalls, memory
  pressure, a render-scale change or a rendering-technology shift. USE FOR: "the app got slower",
  a FPS drop after a release, stutter reports, deciding whether a regression is real or noise.
  Trigger phrases: performance regression, FPS dropped, why is it slow, stutter, jank, frame drops,
  did the last release slow things down, triage performance.
tools:
  - insight_movers
  - insight_anomalies
  - insight_significance
  - insight_baseline
  - perf_summary
  - perf_distribution
  - frame_time_percentiles
  - jank_rate
  - perf_by_device
  - perf_by_scene
  - perf_heatmap
  - compile_stalls
  - resource_percentiles
  - render_scale_truth
  - rendering_technology
  - query
capabilities:
  - query
args:
  - name: scene
    required: false
    description: Optional scene id to scope the triage to (see the uptimizr://scenes resource).
  - name: range
    required: false
    default: the last 14 days
    description: The window to triage, in words — e.g. "the last 14 days", "since the release".
---

Triage the performance regression in {{scope}} over {{range}}: is it real, when did it start, who
does it hit, and what is causing it?

Work through the method below with the read-only tools it names, then answer.

1. **Orient before you ask anything.** Read the `uptimizr://context` resource first: the real scene
   ids, the data freshness, and which metrics are empty because their capture channel is off. A
   performance channel that was never enabled looks exactly like a scene with no problem.

2. **Confirm something moved.** `insight_movers`{{#scene}} (`scene="{{scene}}"`){{/scene}} ranks
   every comparable metric against the previous equal window by how unusual the change is. Read
   `direction` with the sign of `delta` — a _rise_ in jank or errors is a regression — and drop any
   row with `aboveMinSample: false`.

3. **Ask whether the new level is outside normal.** `insight_baseline` on `perf_summary` gives the
   project's own median and spread; compare the new reading with `median` give or take a few `mad`,
   or with the p10..p90 band. Frame rates are noisy, and "down 6 FPS" is routine in some projects
   and an incident in others.

4. **Prove it rather than asserting it.** `insight_significance` on the metric that moved reports
   the effect, a 95 % interval and a p-value across the two windows. An interval straddling 0 means
   you cannot tell yet; `powerNote` says what this much data could have detected at all. Say "not
   yet distinguishable from noise" when that is the truth — it is a finding.

5. **Put a date on it.** `insight_anomalies` (`metric=perf_summary`, `window=28`{{#scene}},
   `scene="{{scene}}"`{{/scene}}) separates a one-day `spike`/`drop` from a `shift` — a level that
   changed and stayed changed, which is what a release looks like. Quote the `bucketStart` and the
   `contributor`. For the day-by-day shape around that date, ask the `query` tool for
   `metric: "perf_daily"` — it is a registry metric with no canned tool of its own.

6. **Locate it.** `perf_by_scene` (which scene), `perf_by_device` (which device class — a
   regression that only hits low-end hardware is a different bug from one that hits everyone), and
   `perf_heatmap`{{#scene}} (`scene="{{scene}}"`){{/scene}} for _where in the scene_ the frames are
   being lost. Ask for `format: "summary"` on the heatmap: merged clusters with shares, not a grid.

7. **Name the mechanism.** `frame_time_percentiles` and `jank_rate` separate "uniformly slower"
   from "occasionally catastrophic" — the second is what users report and the average hides.
   `perf_distribution` shows whether the whole population shifted or a tail got worse.
   `compile_stalls` finds shader/pipeline compilation blocking the first seconds.
   `resource_percentiles` finds GPU/memory pressure. `render_scale_truth` catches a resolution
   change quietly doing the work the frame rate is getting credit for, and `rendering_technology`
   catches a shift in the engine/renderer mix between the two windows — a "regression" that is
   really a change in who is measuring.

8. **Cut it any way you need with the DSL.** The single `query` tool takes a `metric`, a `range`,
   that metric's filters and `compare: { range: <the window before the shift> }`, returning
   `{ current, previous, delta, deltaPct }` already joined — never subtract two runs yourself. Use
   `dimensions` to regroup a portable count, `format: "summary"` for a bounded digest with a
   `reading` and a per-row `drillQuery`, and `explain: true` whenever a number looks impossible:
   the plan names the sample size, the row cap and every capture channel that could make it lie.

## What to report

- Whether the regression is real, with the effect, the interval and the honest verdict when it is
  not yet distinguishable from noise.
- The date it started and whether it is a spike or a sustained shift.
- Who it hits: scene, device class, and where in the scene.
- The mechanism, named, with the metric that shows it.

Carry the caveats: percentiles below the metric's minimum sample, a session count too small to
generalise, sampled capture (ADR 0012), truncated results, and any device class whose share of
traffic changed between the windows — a mix shift moves the average without anything getting slower.

End with 2–3 concrete recommendations naming the scene, the device class or the asset they apply
to. If an `annotate` tool is available, leave a dated note on the shift so the next report can see
what happened; `save_analysis` keeps the triage for the post-mortem. If a `pin_panel` tool is
available, pin the panel that shows the regression.
