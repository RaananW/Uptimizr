---
"@uptimizr/playcanvas": minor
---

Add first-class `asset_load` capture to the PlayCanvas connector. It hooks the
`app.assets` registry load lifecycle (`load:start` → `load` / `error`) and emits
one `asset_load` per observed load with the asset name, load duration (`loadMs`),
and byte size (`bytes`, when known). Privacy-first (ADR 0003): only the asset's
app-defined name is recorded — never the file URL. On by default; disable via
`capture: { assetLoad: false }`.
