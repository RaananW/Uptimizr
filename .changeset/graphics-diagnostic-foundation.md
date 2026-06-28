---
"@uptimizr/schema": minor
"@uptimizr/sdk-core": minor
---

Add the `graphics_diagnostic` event contract and the `captureGraphicsDiagnostics`
opt-in flag (ADR 0021 part 2, foundation). The new event is a single
engine-agnostic GPU-health signal with `severity`, `category`, optional `backend`
(reusing the `graphics.api` enum), length-capped `message`/`code`, and a `count`
field that discriminates a discrete incident marker from an aggregated per-session
rollup. Capture is gated by the new `captureGraphicsDiagnostics` flag in
`@uptimizr/sdk-core`, **off by default** (mirroring `captureErrors`);
`context_lost`/`context_restored` stay always-on and exempt. No connector capture
wiring yet — that lands in the per-signal slices.
