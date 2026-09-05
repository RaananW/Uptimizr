---
"@uptimizr/unity": patch
---

Add a `node:vm` sanity test for the engine-side `Uptimizr.jslib` shim: it evaluates the
plugin with mocked Emscripten globals, resolves the `$UptimizrUnityBridge` library object
the way Emscripten does, and asserts every C-callable export forwards correctly to
`window.__uptimizr_unity__` (protocol version and `-1` when absent; pose with `fov < 0`
omitted; pick name decoded via `UTF8ToString` and empty names dropped; perf with
`longFrames < 0` omitted; scene proxy JSON parsed and invalid / non-array input ignored),
that every export declares its `__deps`, and that the export set matches the
`[DllImport]`s in `UptimizrUnityBridge.cs`.

Docs: the bridged tier is labelled **preview** until verified against a local build, and
the README points at the new sample Unity project (`examples/unity-web-export/`) plus the
one-step WebGL build that drives the real-export Playwright spec (#253).
