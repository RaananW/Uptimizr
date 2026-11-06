---
"@uptimizr/db": patch
"@uptimizr/metrics": patch
---

Rank `format=summary` by what the measure means: `insight_movers` and `insight_anomalies` by magnitude, so the biggest drops no longer sort below flat metrics, and `insight_scene_health` worst-first. Below-sample movers rank after every real one, and the `reading` sentence follows the order.
