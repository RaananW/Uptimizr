# AGENTS.md — @uptimizr/mcp

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

A **read-only** Model Context Protocol (MCP) server over an Uptimizr collector's query API. It
lets an agent query a consumer's **own** 3D analytics in natural language. Each tool maps to one
documented collector read endpoint; the server is a thin wrapper that holds no business logic and
performs `GET` requests only (ADR 0005, ADR 0017).

It connects **only to the collector's HTTP query API** (never to the database directly), so the
collector remains the single gateway that enforces auth, per-project scoping, and privacy.

## Run

```bash
UPTIMIZR_COLLECTOR_URL="https://collect.example.com" UPTIMIZR_API_KEY="utk_…" npx @uptimizr/mcp
```

## Tools (read-only)

**69 tools, generated** from the `@uptimizr/db` semantic metric registry (ADR 0051 §1) — one per
metric the collector serves on a read endpoint. Names are the registry ids; the full table lives in
[README.md](./README.md), and `uptimizr://capabilities` enumerates them at runtime.

Orientation: `list_sessions`, `list_scenes`, `session_meta`, `scene_representation`, `timeseries`,
`event_counts`. Attention: the `*_heatmap` family, `mesh_dwell`, `mesh_blind_spots`, `hover_dwell`.
Interaction: `top_meshes`, `mesh_sources`, `mesh_trend`, `mesh_interaction_kinds`,
`mesh_reachability`, `dead_clicks`, `rage_clicks`, `interaction_sources`, `top_input_actions`.
Navigation: `aggregate_paths`, `session_trajectory`, `scene_coverage`, `navigation_stats`,
`backtrack_ratio`, `camera_distance`, `camera_gestures`. Performance: `perf_summary`, `jank_rate`,
`perf_by_device`, `perf_by_scene`, `perf_heatmap`, `fps_histogram`, `frame_time_percentiles`,
`compile_stalls`, `resource_summary`, `rendering_technology`, … Errors: `stability_counts`,
`graphics_diagnostics`, `error_heatmap`, `capability_changes`. XR/AR: the `xr_*` and
`ar_placement_*` families. Conversion: `funnel`, `scene_retention`, `load_bounce_funnel`,
`variant_leaderboard`.

Most accept `since`/`until` (epoch ms) plus endpoint-specific filters (`scene`, `session`, `source`,
`bins`, `cellSize`, `limit`, `cameraMode`, `region`, …). Every tool declares an `outputSchema` and
returns `structuredContent` (`{ rows }`) alongside the JSON text — read the schema instead of
guessing the row shape, and read the tool description for the metric's caveats before trusting a
small sample.

## Rules for agents

- **Read-only and privacy-preserving.** Never add ingestion, mutation, or raw per-session event
  tools here. No data leaves the consumer's infrastructure (ADR 0003).
- The server talks only to the configured collector with the consumer's `x-api-key`; never hardcode
  or log credentials.
- Keep it a thin wrapper: the `readTools` catalog (defined in `@uptimizr/agent-core`) is
  **generated** from the `@uptimizr/db` metric registry, so a new tool = a new registry entry for a
  documented query endpoint — never a hand-written array entry here. Do not add
  aggregation/business logic — that lives in the collector.
- Tool definitions are pure (`buildRequest`) and must stay unit-testable without a live collector.

## Programmatic API

`readMcpConfig()`, `createMcpServer(client)`, and the shared building blocks re-exported from
[`@uptimizr/agent-core`](https://www.npmjs.com/package/@uptimizr/agent-core):
`createCollectorClient(config)` and `readTools`.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
