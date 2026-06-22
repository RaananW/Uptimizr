---
---

ci: speed up the PR and main pipelines and add an end-to-end gate. Persist
Turbo's cache between runs (`actions/cache` on `.turbo`) so unchanged packages
skip lint/typecheck/build/test. On PRs, gitleaks now scans only the PR's commit
range instead of full history. Adds a parallel Playwright `e2e` job that drives
the browser → SDK → collector (DuckDB) → dashboard/replay round trip and uploads
failure artifacts. No package changes.
