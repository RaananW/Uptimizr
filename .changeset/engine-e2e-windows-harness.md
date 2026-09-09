---
"@uptimizr/godot": patch
"@uptimizr/unity": patch
---

Fix the engine round-trip harness on Windows, where it could not start at all. The
playground's Vite dev server watched `e2e/.tmp/`, which holds the harness DuckDB store;
DuckDB keeps an exclusive lock on that file for the length of a run and Windows raises
`EBUSY` when watching a locked file, so the server died on boot and every e2e spec
failed. Separately, `serveUnityBuild` rejected path traversal by testing for a
`distDir + "/"` prefix, which never matches the backslash paths `resolve` returns on
Windows — so every Unity build asset returned 403 — and `.prettierignore` did not cover
Unity's generated `Library/`, `Temp/`, `Obj/` and `Logs/`, so building the sample project
broke `format:check`. Harness only — no change to either published connector.
