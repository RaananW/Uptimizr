---
"@uptimizr/unity": patch
---

Document the connector against Unity 6. The reference project
(`examples/unity-web-export`) moves from 2022.3 LTS to 6000.6.0f1, and the setup docs
follow Unity 6's renames — **File → Build Profiles** replaces _Build Settings_, and the
platform is **Web** rather than _WebGL_. A new "Input backends and picks" section spells
out which pointer API the shim compiles against for each Active Input Handling setting,
and warns that picks are dropped for the first few seconds of a session on the Input
System backend (measured on 6000.6: a click as `createUnityInstance` resolves never
reaches the bridge, the same click ~3s later always does). Documentation and sample
only — no change to the published connector code.
