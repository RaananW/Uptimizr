---
"@uptimizr/react": patch
---

The 3D panels render only when something changed, instead of 60 times a second. The camera dome,
click rays, flow, gaze/click divergence and world, perf and error heatmaps redrew every frame
while nothing moved, and repainted their whole scene whenever the host re-rendered with a freshly
built array prop (the hover labels, a `= []` default), several times a second. They now render
when the camera moves, the viewer points, scrolls or types at the panel, it is resized or its data
changes, plus once every 500 ms. An idle overview with live data used about a quarter of the GPU
CPU time on a software renderer (8 CPU-seconds per 5 s, from 37).
