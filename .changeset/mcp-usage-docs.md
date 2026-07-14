---
"@uptimizr/mcp": patch
---

docs: clarify how to run the MCP server via `npx`, add a GitHub Copilot CLI config example, and
document that the server connects only to the collector's HTTP query API (never the database
directly), keeping the collector the single gateway to the store.
