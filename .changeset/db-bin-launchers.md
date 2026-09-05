---
"@uptimizr/db": patch
---

Ship the `uptimizr-db-migrate` / `uptimizr-db-new-project` bins as checked-in launchers under `bin/` (importing the built CLI), so package managers can link them at install time instead of warning that the `dist/` targets do not exist yet.
