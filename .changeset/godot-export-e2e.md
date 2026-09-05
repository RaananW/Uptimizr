---
"@uptimizr/godot": patch
---

Fix `bridge/UptimizrGodot.gd` failing to compile under Godot 4's default warning settings:
`JavaScriptBridge.create_object(...)` is vararg, so `var nodes := ...` inferred `Variant` and
tripped `inference_on_variant` (an error by default), which made the autoload silently never
load — the bridged tier then captured nothing. The two declarations now carry an explicit
`JavaScriptObject` type. Caught by the new automated proof of the bridged tier (#252): a
headless Godot 4.7.2 Web export of the reference sample project
(`examples/godot-web-export`) driven by Playwright, which asserts `camera_sample`,
`mesh_interaction`, `frame_perf`, and the scene proxy reach the collector with Godot's
right-handed frame normalized. The README now states the tier's verification status and
points at the sample as the reference integration.
