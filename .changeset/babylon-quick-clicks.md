---
"@uptimizr/babylon": patch
---

Record every quick repeat click. The connector subscribed to every pointer type, double taps
included, which turned on Babylon's double-click detection: every second quick click then came
through as a double tap, which the connector ignored (5 quick clicks recorded 3), and the host
scene's own tap handlers lost those clicks too. The connector now leaves double taps out of its
subscription, and records double taps as clicks only when the scene already listens for them.
