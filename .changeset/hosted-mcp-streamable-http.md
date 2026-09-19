---
"@uptimizr/collector-server": minor
"@uptimizr/mcp": minor
---

Serve MCP over Streamable HTTP at `/mcp` behind `COLLECTOR_MCP_HTTP=1` (off by default), so a remote
AI client connects to a self-hosted collector with a URL and an API key instead of running the stdio
server locally (ADR 0051 §7). Every request is authenticated with `x-api-key` or
`Authorization: Bearer`, sessions are capped by `COLLECTOR_MCP_MAX_SESSIONS` and expire after
`COLLECTOR_MCP_SESSION_TTL_MS`, and tool calls are audited with `surface: "mcp-http"`.
`createMcpServer` gains an optional `options.capabilities` so a hosted session's surface can match
its key; the stdio entry point is unchanged.
