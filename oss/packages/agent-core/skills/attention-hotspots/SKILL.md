---
name: attention_hotspots
title: Attention hot-spots for a scene
description: >-
  Find where visitors look and click in a scene: view-direction concentration, gaze→mesh flow, the
  objects that draw the most interaction, and the ones nobody ever notices. USE FOR: deciding where
  to put a call to action, finding ignored or invisible content, explaining why an object gets no
  clicks, laying out a scene around what people actually look at. Trigger phrases: what do people
  look at, attention hotspots, where do visitors click, which meshes get ignored, blind spots,
  gaze heatmap, is anyone seeing this object.
tools:
  - camera_heatmap
  - flow_links
  - click_rays
  - top_meshes
  - mesh_dwell
  - mesh_blind_spots
  - query
capabilities:
  - query
args:
  - name: scene
    required: true
    description: The scene id to analyse (see the uptimizr://scenes resource).
  - name: range
    required: false
    default: the last 7 days
    description: The window to analyse, in words — e.g. "the last 7 days", "since launch".
---

Where does attention concentrate in scene "{{scene}}" over {{range}}?

Work through the method below with the read-only tools it names — all of them scoped with
`scene="{{scene}}"` — and synthesise one answer.

1. **Orient before you ask anything.** Read the `uptimizr://context` resource first: it gives the
   real scene ids, the scene's **named regions** and the custom-event names this project emits, and
   it tells you which metrics are empty because their capture channel is off. Name regions the way
   the project names them — "the checkout counter", not "the cluster at x≈3".

2. **Where do they look?** `camera_heatmap` (`scene="{{scene}}"`) gives the view-direction
   distribution — what people point the camera at, whether or not they ever click it. Ask for
   `format: "summary"`: the digest merges neighbouring cells into a handful of clusters with a
   share each and a plain-language `reading`, which is what you want here; the raw grid is
   thousands of cells you cannot describe.

3. **Does looking turn into touching?** `flow_links` (`scene="{{scene}}"`) links where the gaze was
   to the mesh that was then clicked. A strong link is a working call to action; a heavy look with
   no outgoing link is content that draws the eye and then disappoints.

4. **Where do the clicks land?** `click_rays` (`scene="{{scene}}"`) gives view-gated clicks per
   voxel and mesh — clicks attributed to what the visitor could actually see, not to whatever the
   ray happened to pass through.

5. **Rank the objects.** `top_meshes` (`scene="{{scene}}"`) for the most-interacted meshes, and
   `mesh_dwell` (`scene="{{scene}}"`) for how long attention rests on each one. Dwell without
   interaction is hesitation, and it usually means the object looks clickable and is not, or is
   clickable and does not look it.

6. **Name the cold half.** `mesh_blind_spots` (`scene="{{scene}}"`) lists the meshes that are
   present and essentially never noticed. A hot-spot report that only names hot spots tells you
   nothing about the content you paid to build.

7. **Narrow it with the DSL.** For anything the canned tools do not expose, use the single `query`
   tool: pick the `metric`, bound it with `range`, filter it, and set `format: "summary"` for a
   bounded digest — each summary row carries a `drillQuery` you can send straight back instead of
   rebuilding the filter. Set `compare: { range: <previous window> }` to see whether a hot spot is
   new, and `explain: true` when a result looks wrong or empty: the plan names the capture channel,
   the sample size and the row cap behind it.

## What to report

- The two or three real hot-spots, named with the project's own region and mesh names, each with
  its share of attention.
- The cold areas and the meshes nobody notices.
- Where gaze fails to convert into interaction, and what that implies for layout and
  call-to-action placement.

Carry the caveats: heatmaps are gated on the view/pointer capture channels and are sampled
(ADR 0012), so a share is a share _of the sampled events_; say so, and say when a result was
truncated (`meta.truncated`) or sits below the metric's own minimum sample. Do not turn a voxel
cluster into a claim about one object unless `click_rays` or `flow_links` attributes it to that
mesh.

End with 2–3 concrete layout or content recommendations. If an `annotate` tool is available, leave
a note on the region you want revisited — a region-scoped annotation is what makes the next report
open where this one ended. If a `pin_panel` tool is available, pin the heatmap panel you reasoned
from.
