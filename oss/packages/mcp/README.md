# @uptimizr/mcp

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server over an
Uptimizr collector's query API. It lets an AI agent ask natural-language questions about your
3D analytics ("what was the most-clicked mesh this week?") and have them answered by querying
**your own** collector — nothing is sent to any third party.

The server is a thin wrapper: each tool maps one-to-one to a documented collector query endpoint
(see [integration docs](https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md)). It
performs `GET` requests only — there are **no ingestion, mutation, or raw per-session event
tools**.

## How it connects

The server talks **only to your collector's HTTP query API** — it never opens the database
(DuckDB/ClickHouse/Postgres) directly. The collector stays the single gateway to your data, so an
agent gets exactly the auth, project-scoping, and privacy guarantees a dashboard user does:

```text
AI agent ──stdio──▶ @uptimizr/mcp ──HTTPS GET + x-api-key──▶ collector ──▶ store
```

## Run

```bash
UPTIMIZR_COLLECTOR_URL="https://collect.example.com" \
UPTIMIZR_API_KEY="utk_…" \
npx @uptimizr/mcp
```

| Environment variable     | Required | Notes                                              |
| ------------------------ | -------- | -------------------------------------------------- |
| `UPTIMIZR_COLLECTOR_URL` | yes      | Base URL of **your** collector.                    |
| `UPTIMIZR_API_KEY`       | yes      | Your project API key (`x-api-key`), read-only use. |

### Configure an MCP client

Most MCP clients (Claude Desktop, VS Code, etc.) launch the server over stdio. Example client
config:

```json
{
  "mcpServers": {
    "uptimizr": {
      "command": "npx",
      "args": ["-y", "@uptimizr/mcp"],
      "env": {
        "UPTIMIZR_COLLECTOR_URL": "https://collect.example.com",
        "UPTIMIZR_API_KEY": "utk_…"
      }
    }
  }
}
```

For **GitHub Copilot CLI**, put the same entry in `~/.copilot/mcp-config.json` with
`"type": "local"` and `"tools": ["*"]`, then restart the CLI so it loads the tools:

```json
{
  "mcpServers": {
    "uptimizr": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@uptimizr/mcp"],
      "env": {
        "UPTIMIZR_COLLECTOR_URL": "http://localhost:4318",
        "UPTIMIZR_API_KEY": "utk_…"
      },
      "tools": ["*"]
    }
  }
}
```

## Tools

The catalog is **generated from the semantic metric registry** in `@uptimizr/db` (ADR 0051 §1):
every aggregation the collector serves on a read endpoint is a tool — **69** of them. Each tool's
description carries the metric's interpretation notes and caveats, and each declares an MCP
`outputSchema` for the rows it returns (results come back as both `content` text and
`structuredContent`).

Most tools accept an optional time range (`since` / `until`, epoch ms) and the filters the
underlying endpoint supports (`scene`, `session`, `source`, `bins`, `cellSize`, `interval`, `type`,
`limit`, `cameraMode`, `region`, …). `session_meta`, `session_trajectory` and
`scene_representation` take a required id.

### Sessions & orientation

| Tool                   | Endpoint                                 | Returns                                   |
| ---------------------- | ---------------------------------------- | ----------------------------------------- |
| `list_sessions`        | `/api/v1/sessions`                       | Recent sessions.                          |
| `session_meta`         | `/api/v1/sessions/:id/meta`              | Session descriptor (no raw event stream). |
| `scene_representation` | `/api/v1/scenes/:sceneId/representation` | Scene representation.                     |
| `list_scenes`          | `/api/v1/scenes`                         | Active scenes.                            |
| `timeseries`           | `/api/v1/timeseries`                     | Event volume over time.                   |
| `event_counts`         | `/api/v1/event-counts`                   | Counts per event type.                    |

### Attention & spatial

| Tool                      | Endpoint                          | Returns                              |
| ------------------------- | --------------------------------- | ------------------------------------ |
| `pointer_heatmap`         | `/api/v1/heatmaps/pointer`        | 2D pointer heatmap.                  |
| `mesh_uv_heatmap`         | `/api/v1/heatmaps/mesh-uv`        | Per-mesh UV (texture-space) heatmap. |
| `world_heatmap`           | `/api/v1/heatmaps/world`          | 3D world-space pointer heatmap.      |
| `world_heatmap_stats`     | `/api/v1/heatmaps/world/stats`    | World heatmap totals.                |
| `gaze_heatmap`            | `/api/v1/heatmaps/gaze`           | World-space gaze heatmap.            |
| `gaze_heatmap_stats`      | `/api/v1/heatmaps/gaze/stats`     | Gaze heatmap totals.                 |
| `camera_heatmap`          | `/api/v1/heatmaps/camera`         | View-direction heatmap.              |
| `view_coverage_histogram` | `/api/v1/coverage/view-histogram` | 360° view-coverage histogram.        |
| `mesh_dwell`              | `/api/v1/meshes/dwell`            | Per-object dwell / attention.        |
| `mesh_blind_spots`        | `/api/v1/meshes/blind-spots`      | Blind spots / never-noticed meshes.  |
| `hover_dwell`             | `/api/v1/hover/dwell`             | Hover hesitation per object.         |

### Meshes & interaction

| Tool                     | Endpoint                       | Returns                            |
| ------------------------ | ------------------------------ | ---------------------------------- |
| `click_rays`             | `/api/v1/heatmaps/click-rays`  | View-gated click rays.             |
| `flow_links`             | `/api/v1/heatmaps/flow`        | Gaze → mesh flow links.            |
| `top_meshes`             | `/api/v1/meshes/top`           | Most-interacted meshes.            |
| `mesh_sources`           | `/api/v1/meshes/sources`       | Mesh interactions by input source. |
| `mesh_trend`             | `/api/v1/meshes/trend`         | Per-mesh interaction trend.        |
| `mesh_interaction_kinds` | `/api/v1/meshes/kinds`         | Interaction kinds per mesh.        |
| `mesh_reachability`      | `/api/v1/meshes/reachability`  | Mesh reachability by distance.     |
| `dead_clicks`            | `/api/v1/clicks/dead`          | Dead-click rate.                   |
| `rage_clicks`            | `/api/v1/clicks/rage`          | Rage-click clusters.               |
| `interaction_sources`    | `/api/v1/interactions/sources` | Interactions by input source.      |
| `top_input_actions`      | `/api/v1/input-actions/top`    | Most-used shortcuts and actions.   |

### Navigation

| Tool                 | Endpoint                                 | Returns                              |
| -------------------- | ---------------------------------------- | ------------------------------------ |
| `position_heatmap`   | `/api/v1/heatmaps/position`              | Floor-plan camera-position heatmap.  |
| `session_trajectory` | `/api/v1/sessions/:sessionId/trajectory` | Session walked path.                 |
| `aggregate_paths`    | `/api/v1/paths`                          | Aggregate desire-line paths.         |
| `scene_coverage`     | `/api/v1/coverage`                       | Scene coverage / dead zones.         |
| `camera_distance`    | `/api/v1/camera/distance`                | Camera distance / zoom distribution. |
| `camera_gestures`    | `/api/v1/camera-gestures`                | Camera navigation gestures.          |
| `navigation_stats`   | `/api/v1/navigation`                     | Navigation effort per session.       |
| `backtrack_ratio`    | `/api/v1/backtrack`                      | Path retrace / backtracking.         |

### Performance

| Tool                     | Endpoint                            | Returns                             |
| ------------------------ | ----------------------------------- | ----------------------------------- |
| `perf_summary`           | `/api/v1/perf`                      | Rendering performance summary.      |
| `render_scale_truth`     | `/api/v1/perf/render-scale`         | Render-scale truth.                 |
| `perf_distribution`      | `/api/v1/perf/distribution`         | FPS distribution (per-session).     |
| `fps_histogram`          | `/api/v1/perf/fps-histogram`        | Per-session median-FPS histogram.   |
| `frame_time_percentiles` | `/api/v1/perf/frame-time`           | Frame-time percentiles.             |
| `jank_rate`              | `/api/v1/perf/jank`                 | Jank rate.                          |
| `perf_churn`             | `/api/v1/perf/churn`                | Perf-correlated churn.              |
| `perf_by_device`         | `/api/v1/perf/by-device`            | FPS by device class.                |
| `perf_by_scene`          | `/api/v1/perf/by-scene`             | FPS by scene.                       |
| `perf_heatmap`           | `/api/v1/heatmaps/perf`             | Spatial FPS heatmap.                |
| `compile_stalls`         | `/api/v1/perf/compile-stalls`       | Shader / pipeline compile stalls.   |
| `resource_summary`       | `/api/v1/perf/resources`            | GPU / memory footprint summary.     |
| `resource_percentiles`   | `/api/v1/perf/resource-percentiles` | GPU / memory footprint percentiles. |
| `rendering_technology`   | `/api/v1/rendering-technology`      | Rendering-technology mix.           |

### Errors & stability

| Tool                   | Endpoint                       | Returns                            |
| ---------------------- | ------------------------------ | ---------------------------------- |
| `stability_counts`     | `/api/v1/perf/stability`       | Stability incidents.               |
| `graphics_diagnostics` | `/api/v1/graphics-diagnostics` | Engine diagnostic counts.          |
| `error_heatmap`        | `/api/v1/heatmaps/errors`      | Spatial error heatmap.             |
| `capability_changes`   | `/api/v1/capabilities`         | Capability / fidelity transitions. |

### XR

| Tool                     | Endpoint                          | Returns                            |
| ------------------------ | --------------------------------- | ---------------------------------- |
| `xr_rotation`            | `/api/v1/xr/rotation`             | XR head-rotation rate.             |
| `xr_sources`             | `/api/v1/xr/sources`              | XR input-source usage.             |
| `xr_abandonment`         | `/api/v1/xr/abandonment`          | XR session abandonment.            |
| `xr_locomotion`          | `/api/v1/xr/locomotion`           | XR locomotion & comfort.           |
| `xr_tracking_quality`    | `/api/v1/xr/tracking`             | XR tracking quality.               |
| `boundary_heatmap`       | `/api/v1/heatmaps/boundary`       | Guardian / boundary-touch heatmap. |
| `boundary_heatmap_stats` | `/api/v1/heatmaps/boundary/stats` | Boundary heatmap totals.           |
| `xr_boundary_contacts`   | `/api/v1/xr/boundary-contacts`    | Boundary contacts per session.     |

### AR

| Tool                         | Endpoint                             | Returns                        |
| ---------------------------- | ------------------------------------ | ------------------------------ |
| `ar_placement_time_to_place` | `/api/v1/ar/placement/time-to-place` | AR time-to-place distribution. |
| `ar_placement_attempts`      | `/api/v1/ar/placement/attempts`      | AR re-placement distribution.  |
| `ar_placement_surfaces`      | `/api/v1/ar/placement/surfaces`      | AR placement surfaces.         |

### Conversion

| Tool                  | Endpoint                      | Returns                           |
| --------------------- | ----------------------------- | --------------------------------- |
| `funnel`              | `/api/v1/funnel`              | Conversion funnel (`steps` JSON). |
| `scene_retention`     | `/api/v1/scene-retention`     | Scene-to-scene retention.         |
| `load_bounce_funnel`  | `/api/v1/load-bounce`         | Load → bounce funnel.             |
| `variant_leaderboard` | `/api/v1/variant-leaderboard` | Variant → conversion leaderboard. |

## Resources & prompts

The server also exposes read-only **resources** for self-discovery — `uptimizr://capabilities`
(a machine-readable descriptor of event types, the tool catalog, and parameter semantics) and
`uptimizr://scenes` (live scene ids) — and curated **prompts** (`weekly_scene_health`,
`attention_hotspots`, `xr_comfort_review`) that drive the tools above. A remote Streamable HTTP
transport is a deferred, auth-gated follow-up (ADR 0050 §7). See the
[MCP guide](https://uptimizr.com/docs/guides/mcp/) for details.

## Programmatic use

```ts
import { createCollectorClient, createMcpServer, readMcpConfig } from "@uptimizr/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const client = createCollectorClient(readMcpConfig());
const server = createMcpServer(client);
await server.connect(new StdioServerTransport());
```

The package also exports `readTools`, `CollectorError`, `version`, and the related public types.
The read-only tool catalog (`readTools`) and the `GET`-only collector client are defined in the
framework-agnostic [`@uptimizr/agent-core`](../agent-core/README.md) package and re-exported here,
so the agent tool surface is defined once and shared across the MCP server, the dashboard assistant,
and the demo assistant (ADR 0050). Building a non-MCP agent? Depend on `@uptimizr/agent-core`
directly — it also ships a headless provider-adapter interface and tool-calling loop.

## Develop

```bash
pnpm --filter @uptimizr/mcp build
pnpm --filter @uptimizr/mcp typecheck
pnpm --filter @uptimizr/mcp test
```

Licensed under [Apache-2.0](./LICENSE).
