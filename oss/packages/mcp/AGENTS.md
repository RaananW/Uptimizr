# AGENTS.md — @uptimizr/mcp

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

A **read-only** Model Context Protocol (MCP) server over an Uptimizr collector's query API. It
lets an agent query a consumer's **own** 3D analytics in natural language. Each tool maps to one
documented collector read endpoint; the server is a thin wrapper that holds no business logic and
performs `GET` requests only (ADR 0005, ADR 0017).

## Run

```bash
UPTIMIZR_COLLECTOR_URL="https://collect.example.com" UPTIMIZR_API_KEY="utk_…" npx @uptimizr/mcp
```

## Tools (read-only)

`list_sessions`, `pointer_heatmap`, `world_heatmap`, `camera_heatmap`, `click_rays`, `flow_links`,
`top_meshes`, `perf_summary`, `list_scenes`, `timeseries`, `event_counts`, `session_meta`,
`scene_representation`. Most accept `since`/`until` (epoch ms) plus endpoint-specific filters
(`scene`, `session`, `source`, `bins`, `cellSize`, `limit`).

## Rules for agents

- **Read-only and privacy-preserving.** Never add ingestion, mutation, or raw per-session event
  tools here. No data leaves the consumer's infrastructure (ADR 0003).
- The server talks only to the configured collector with the consumer's `x-api-key`; never hardcode
  or log credentials.
- Keep it a thin wrapper: a new tool = a new entry in the `readTools` registry mapping to a
  documented query endpoint. Do not add aggregation/business logic — that lives in the collector.
- Tool definitions are pure (`buildRequest`) and must stay unit-testable without a live collector.

## Programmatic API

`readMcpConfig()`, `createCollectorClient(config)`, `createMcpServer(client)`, `readTools`.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
