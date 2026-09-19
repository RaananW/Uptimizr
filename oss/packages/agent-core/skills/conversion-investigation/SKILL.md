---
name: conversion_investigation
title: Conversion investigation
description: >-
  Find out where a funnel loses people and whether the loss is real: step-by-step drop-off, the
  bounce that happens before the funnel even starts, scene-to-scene retention, variant performance,
  and the interaction failures (dead clicks, rage clicks, unreachable meshes) that explain a stalled
  step. USE FOR: a funnel that converts worse than expected, an A/B variant comparison, "where do
  people drop off", diagnosing a step nobody completes. Trigger phrases: conversion, funnel,
  drop-off, why are people leaving, which variant wins, bounce rate, retention, people get stuck.
tools:
  - funnel
  - load_bounce_funnel
  - scene_retention
  - variant_leaderboard
  - dead_clicks
  - rage_clicks
  - mesh_reachability
  - flow_links
  - insight_significance
  - insight_movers
  - query
capabilities:
  - query
args:
  - name: scene
    required: false
    description: Optional scene id to scope the investigation to (see the uptimizr://scenes resource).
  - name: range
    required: false
    default: the last 7 days
    description: The window to investigate, in words — e.g. "the last 7 days", "since the release".
---

Investigate conversion for {{scope}} over {{range}}: where do people drop off, and is the drop real?

Work through the method below with the read-only tools it names, then answer.

1. **Orient before you ask anything.** Read the `uptimizr://context` resource first. A funnel is
   built out of **this project's own event types and custom-event names** — invent one and every
   step reads zero. The context document lists the vocabulary the application actually emits, the
   real scene ids, and which metrics are empty because their capture channel is off.

2. **Check the step before the first step.** `load_bounce_funnel`{{#scene}} (`scene="{{scene}}"`){{/scene}}
   measures load → first interaction → stay. If people leave before the funnel starts, nothing
   inside it will explain the number, and a "conversion problem" is really a load or a first-impression
   problem.

3. **Run the funnel itself.** `funnel`{{#scene}} (`scene="{{scene}}"`){{/scene}} with the `steps`
   built from the context document's vocabulary. Read it as the _transition_ rates, not the totals:
   the step with the worst step-to-step rate is the one to investigate, even when a later step has
   fewer people in absolute terms.

4. **Follow them out of the scene.** `scene_retention`{{#scene}} (`scene="{{scene}}"`){{/scene}}
   shows where a visitor goes next. A step that "loses" people to the next scene is not a loss at
   all; one that loses them to nothing is.

5. **Explain the stalled step.** At the worst step, look for interaction failure rather than
   intent: `dead_clicks` (clicks that hit nothing actionable), `rage_clicks` (repeated clicking in
   one spot — frustration you can locate), `mesh_reachability` (the target is too far away or
   behind something to be clicked at all) and `flow_links` (people look at the target and never
   click it). One of these usually _is_ the drop-off.

6. **Compare variants honestly.** `variant_leaderboard` ranks variants by conversion. A leaderboard
   is not a verdict: check each variant's sample size before repeating its rate, and say plainly
   when two variants are too close or too small to separate. `insight_significance` can test a
   metric with a portable bucket series across two **windows**; it does not test one segment against
   another, and if you ask it to it will say so — report that limitation rather than inventing a
   p-value.

7. **See whether this is new.** `insight_movers`{{#scene}} (`scene="{{scene}}"`){{/scene}} ranks
   what changed against the previous equal window, so you can tell "this funnel has always been bad"
   from "this funnel broke last Tuesday". Ignore any row with `aboveMinSample: false`.

8. **Use the DSL for the cuts the canned tools do not expose.** The single `query` tool takes a
   `metric`, a `range`, that metric's filters, and `compare: { range: <previous window> }` to return
   `{ current, previous, delta, deltaPct }` already joined — do not subtract two runs by hand. Use
   `dimensions` to regroup a portable count (by device class, source or scene) and
   `format: "summary"` for a bounded digest with a `reading` and a `drillQuery` per row. When a step
   reads zero, re-send it with `explain: true` before reporting it: the plan will tell you whether
   the number is real or whether the channel behind it is switched off.

## What to report

- The step that actually loses people, with its entry and exit counts and its transition rate.
- The mechanism, named: dead clicks on a specific mesh, an unreachable target, a bounce before the
  first interaction, or a genuine loss of interest.
- What each variant did, with sample sizes, and whether the difference can be told apart from noise.

Carry the caveats into the text: funnel steps are only as good as the event vocabulary they were
built from, a rate over a handful of sessions is not a rate, `meta.truncated` means you are looking
at a cut-off list, and a disabled capture channel produces a zero that means "not measured".

End with 2–3 concrete recommendations tied to the step and the mesh they apply to. If an `annotate`
tool is available, leave a note on the failing step so the next investigation starts there, and use
`save_analysis` to store the funnel definition you settled on — the next run should not have to
guess the steps again. If a `pin_panel` tool is available, pin the funnel panel.
