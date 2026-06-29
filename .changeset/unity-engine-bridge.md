---
"@uptimizr/unity": minor
---

Ship the Unity engine-side bridge — the **copy-in asset** that unlocks the bridged capture
tier (ADR 0045, #110). `bridge/` now contains a real `Uptimizr.jslib` Emscripten plugin and
an example `UptimizrUnityBridge` `MonoBehaviour` (replacing the placeholder): the C# side
samples the active `Camera` pose, raycast picks (named object + world hit point), and FPS
each interval and pushes them over the versioned `EngineBridge` on
`window.__uptimizr_unity__`. The shim asserts `BRIDGE_PROTOCOL_VERSION` (1) on start and does
**no** coordinate math — it forwards Unity's native-frame (left-handed, y-up, meters) values
and the connector applies the identity normalization. Privacy-safe per ADR 0003: only poses,
FPS, and developer-named objects cross the boundary — no invented IDs, no raw input text.

Docs (the connector page, package README, `bridge/README.md`, and `docs/integration.md`) now
cover the engine-side setup (copy `Uptimizr.jslib` to `Assets/Plugins/WebGL/`, add the
MonoBehaviour to a GameObject) alongside the zero-engine-code JS-only tier. No
`@uptimizr/schema` change — the connector still emits only existing events.
