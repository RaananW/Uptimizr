---
"@uptimizr/mcp": patch
---

refactor(mcp): source the read-only tool catalog and collector client from the new
`@uptimizr/agent-core` package instead of defining them locally, so the tool surface is defined
once and can't drift from the dashboard/demo assistants (ADR 0050). Public API and MCP runtime
behavior are unchanged — the catalog and client are re-exported.
