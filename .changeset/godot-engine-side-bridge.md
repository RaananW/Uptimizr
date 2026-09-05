---
"@uptimizr/godot": patch
---

Ship the Godot 4 engine-side bridge as a copy-in asset, unlocking the connector's bridged
tier (ADR 0045, #113). Adds working `bridge/UptimizrGodot.gd` (GDScript) and
`bridge/UptimizrGodot.cs` (C#) autoloads that use `JavaScriptBridge` to read the active
`Camera3D` world pose (forward `-basis.z`, up `basis.y`, fov in radians), FPS, left-click
raycast picks (named collider + world hit point), and an opt-in scene proxy, then push them
over `window.__uptimizr_godot__`. The shim asserts the bridge protocol version, guards on
`OS.has_feature("web")` (no-op off the Web export), pushes world-space values in Godot's
native right-handed/y-up/meters frame (the connector negates Z), and stays privacy-safe
(ADR 0003): only poses, FPS, and developer-named objects — no invented IDs, no raw input.
The public TypeScript surface is unchanged; the JS-only tier still works with no engine code.
