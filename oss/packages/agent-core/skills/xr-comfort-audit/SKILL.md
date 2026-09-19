---
name: xr_comfort_audit
title: XR comfort & drop-off audit
description: >-
  Audit VR/AR comfort for a scene (or the whole project): rapid head rotation, locomotion style,
  tracking quality, guardian/boundary contacts, input-source mix, and the short sessions that mean
  someone took the headset off. USE FOR: motion-sickness complaints, immersive sessions that end
  early, choosing a locomotion scheme, checking whether a play space is big enough. Trigger phrases:
  XR comfort, VR motion sickness, why do people quit VR, headset drop-off, teleport vs smooth
  locomotion, guardian boundary, hand tracking vs controllers.
tools:
  - xr_rotation
  - xr_locomotion
  - xr_abandonment
  - xr_sources
  - xr_tracking_quality
  - xr_boundary_contacts
  - boundary_heatmap_stats
  - insight_scene_health
  - insight_movers
  - query
capabilities:
  - query
args:
  - name: scene
    required: false
    description: Optional scene id to scope the audit to (see the uptimizr://scenes resource).
  - name: range
    required: false
    default: the last 7 days
    description: The window to audit, in words — e.g. "the last 7 days", "since the XR release".
---

Audit XR/immersive comfort and drop-off for {{scope}} over {{range}}.

Work through the method below with the read-only tools it names{{#scene}}, all scoped with
`scene="{{scene}}"`{{/scene}}, and correlate the signals — no single one of them is a verdict.

1. **Orient before you ask anything.** Read the `uptimizr://context` resource first. Every metric
   below is gated on the **XR capture channel**: if the context document says it is off, these
   tools return empty by design and the honest answer is "XR capture is not enabled here", not
   "there is no comfort problem".

2. **Rapid head rotation — the motion-sickness proxy.** `xr_rotation`{{#scene}} (`scene="{{scene}}"`){{/scene}}
   gives the rate of fast head/view turns. High rates are a proxy, not a diagnosis: they can mean
   discomfort-inducing camera work, or simply a scene that rewards looking around. Read it against
   the next two signals before calling it.

3. **Locomotion style and session span.** `xr_locomotion`{{#scene}} (`scene="{{scene}}"`){{/scene}}
   gives the fly / navigate / teleport mix and how long each session lasted. Continuous (smooth)
   locomotion paired with heavy rapid rotation is the classic uncomfortable combination; teleport
   is the usual mitigation.

4. **Did they take the headset off?** `xr_abandonment`{{#scene}} (`scene="{{scene}}"`){{/scene}}
   finds immersive sessions that ended early. Early exits _plus_ one of the two signals above is
   the finding; early exits on their own may just be a short demo.

5. **Rule out the boring explanations first.** `xr_tracking_quality` catches tracking loss — an
   exit caused by the headset losing its pose is not a comfort problem.
   `xr_boundary_contacts` and `boundary_heatmap_stats` catch a play space that is too small or a
   scene that pushes people into the guardian; that is a layout problem with a layout fix.

6. **Who is playing.** `xr_sources`{{#scene}} (`scene="{{scene}}"`){{/scene}} gives the hand vs.
   controller vs. gaze input split. Comfort conclusions differ by input source, and a shift in the
   mix between two windows can move every other number without anything getting worse.

7. **Put it in context.** `insight_scene_health` scores XR abandonment as one of its six weighted
   factors, so it tells you whether this scene is unusual _for this project_;
   `insight_movers`{{#scene}} (`scene="{{scene}}"`){{/scene}} tells you whether the comfort signals
   moved against the previous equal window. Drop any row with `aboveMinSample: false`.

8. **Cut it further with the DSL.** The single `query` tool takes a `metric`, a `range`, that
   metric's filters, `dimensions` to regroup a portable count, and `compare: { range: <previous
window> }` for `{ current, previous, delta, deltaPct }` already joined. `format: "summary"`
   returns a bounded digest with a plain-language `reading`; `explain: true` returns the plan
   instead of the rows and names every reason the answer might mislead — worth one call before
   reporting a zero on a channel-gated metric.

## What to report

- The uncomfortable patterns you can actually evidence: heavy rapid rotation or continuous
  locomotion paired with early exits, named per scene and per input source.
- The alternatives you ruled out: tracking loss, boundary contacts, a short-by-design experience.
- Comfort mitigations: teleport or snap-turn options, vignetting during movement, slower or
  user-controlled camera motion, a larger required play space, or moving interactive content
  inside the guardian.

Carry the caveats: XR sessions are a small fraction of most projects' traffic, so say the session
count next to every rate; the rotation and locomotion metrics are sampled (ADR 0012); and a metric
whose channel is off is not a zero. Never turn one uncomfortable session into a trend.

End with 2–3 concrete comfort changes, each tied to the scene and the locomotion or input mode it
applies to. If an `annotate` tool is available, leave a note on the scene so the next audit can see
what was tried; `save_analysis` keeps the before-picture to compare the fix against. If a
`pin_panel` tool is available, pin the locomotion-comfort panel.
