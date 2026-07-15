---
"@uptimizr/dashboard": minor
---

feat(dashboard): embed the in-browser analytics assistant (ADR 0050, closes #193)

The dashboard now ships an "Analytics assistant" drawer that mounts the portable
`<AssistantPanel>` from `@uptimizr/react/assistant`, wired to the active project's
real collector connection (same read-only query API + key the panels use). Ask
natural-language questions of your analytics and get grounded, tool-backed
answers.

The panel and the WebLLM runtime (`@mlc-ai/web-llm`) are **fully code-split**:
they load on demand only when a visitor opens the assistant, so the main bundle
is unchanged for everyone else (guarded by an entry-purity test). Model weights
download on first use behind a consent gate — never eagerly, never precached.

Because the backend-less demo embeds this dashboard build, the same assistant
now works there against the in-browser service-worker / DuckDB-Wasm query layer —
no server and no API key, with a local WebLLM model.
