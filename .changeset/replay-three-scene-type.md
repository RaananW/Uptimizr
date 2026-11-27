---
"@uptimizr/replay": patch
---

`createThreeReplayDriver` now accepts a real `THREE.Scene` for `scene` without a cast. The option was typed with a string index signature, which three's `Scene` doesn't have.
