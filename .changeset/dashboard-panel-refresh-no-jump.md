---
"@uptimizr/dashboard": patch
---

fix(dashboard): keep panel bodies mounted during live refresh so panels no longer "jump"

Registry-driven panels collapsed to a one-line "Loading…" placeholder on every background refetch
(live `revision` bumps, filter changes) and then re-expanded once the data arrived, making the
dashboard visibly jump. `PanelHost` now only shows the loading placeholder while a panel has no
data to render yet — once data is present, refreshes keep the last-rendered body on screen and the
chart redraws in place. Gating on data presence (instead of a "settled once" flag) also fixes a
crash where a panel could render with null data after a transient load error cleared on the next
refetch.
