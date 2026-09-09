---
"@uptimizr/unity": patch
---

Capture picks under either Unity input backend. `UptimizrUnityBridge.cs` read
`UnityEngine.Input` unconditionally, which throws `InvalidOperationException` every
frame when a project has Active Input Handling set to the Input System package — the
common case on Unity 6 — so those projects saw exception spam and no `mesh_interaction`
events at all. Pointer-down is now resolved through `TryGetPrimaryPointerDown`, which
compiles a `Mouse`/`Touchscreen` path under `ENABLE_INPUT_SYSTEM` and the legacy path
under `ENABLE_LEGACY_INPUT_MANAGER` (preferring the Input System when both are
enabled, so a click still yields exactly one push). With neither backend enabled the
bridge degrades to no picks instead of throwing.
