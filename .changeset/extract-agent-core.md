---
"@uptimizr/agent-core": minor
---

feat(agent-core): new framework-agnostic, browser-safe package that owns the agent tool surface
once (ADR 0050 §1).

It provides the read-only tool catalog (`readTools`, one entry per documented aggregate collector
query endpoint), the `GET`-only collector client, a headless LLM provider-adapter interface
(`LlmProvider`), and the headless tool-calling loop (`runAgent`) that drives LLM ↔ tools ↔
collector. Strictly read-only — no ingestion, mutation, or raw per-session event tools (ADR 0003 /
ADR 0017). Consumed by `@uptimizr/mcp` and, in future, the dashboard and demo assistants.
