---
"@uptimizr/collector-server": minor
"@uptimizr/db": patch
---

`uptimizr init` and `uptimizr new-project` now mint the operator's first key as an **owner key** —
`query`, `query:raw` and `annotate`, labelled `owner` — instead of `query` alone, and print the
capability set next to the key. That is the key that drives the dashboard, session replay, the live
per-session follow and scene regions, so switching `ENABLE_RAW_SESSION_RETENTION` on no longer
makes replay answer `403` until a second key is minted and swapped in. `query:raw` grants nothing on
its own: the raw routes need both halves of the gate. `uptimizr new-key` is unchanged and still
defaults to `query`, which is the key to hand an agent or MCP client — `init` now prints that hint.
`pnpm db:seed` grants the demo projects the same three capabilities, matching the repo's other
local provisioning scripts.
