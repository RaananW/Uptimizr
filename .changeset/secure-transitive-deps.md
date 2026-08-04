---
"@uptimizr/collector-server": patch
"@uptimizr/mcp": patch
---

Resolve three security advisories in transitive runtime dependencies by tightening the
workspace overrides: `brace-expansion` to `>=5.0.9` (GHSA-rgw5-rvv9-x895, denial of service
via unbounded intermediate arrays — reached through `@fastify/static`), `fast-uri` to
`>=3.1.5` (GHSA-7p8r-x3mc-p8w7, host confusion via a backslash authority introducer — reached
through Fastify and the MCP SDK), and a new `hono` override at `>=4.12.34`
(GHSA-8j4g-w8fx-2239, regular-expression denial of service in the CORS middleware — reached
through the MCP SDK). No API or behavior changes.
