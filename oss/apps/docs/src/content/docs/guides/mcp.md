---
title: MCP server (AI agents)
description: Let an AI agent answer natural-language questions about your 3D analytics with the read-only @uptimizr/mcp server.
---

`@uptimizr/mcp` is a **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server over
your collector's query API. It lets an AI agent answer natural-language questions about your 3D analytics
("what was the most-clicked mesh this week?") by querying **your own** collector — nothing is sent to any
third party.

It's a thin wrapper: each tool maps one-to-one to a documented [query endpoint](/docs/api/query/) and
performs `GET` requests only. There are **no ingestion, mutation, or raw per-session event tools**.

The tool catalog itself lives in the framework-agnostic, browser-safe **`@uptimizr/agent-core`**
package, which `@uptimizr/mcp` imports. That means the agent tool surface is defined **once** and
shared by every consumer (the MCP server, the dashboard assistant, and the demo assistant), so they
can never drift apart on capabilities. See [ADR 0050](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0050-in-browser-analytics-assistant.md).

## How it connects

The MCP server talks **only to your collector's HTTP query API** — it never opens the database
(DuckDB/ClickHouse/Postgres) directly. The collector stays the single gateway to your data, so the
same auth, scoping, and privacy rules apply whether a human uses the dashboard or an agent uses MCP:

```text
AI agent ──stdio──▶ @uptimizr/mcp ──HTTPS GET + x-api-key──▶ collector ──▶ store (DuckDB / ClickHouse)
```

Because the collector resolves the project from the API key, an agent can only ever read **its own
project's** aggregated data — no cross-project access, no raw events, no PII (ADR 0003 / ADR 0017).

## Get an API key

The MCP server needs a **query-capable** project API key (`utk_…`) — the same kind the dashboard
uses to read. Self-hosting locally, `pnpm db:seed` mints one and prints it once (also written to
`.env` as `NEXT_PUBLIC_API_KEY` / `VITE_API_KEY`). Ingest-only keys are rejected for reads.

## Run

```bash
UPTIMIZR_COLLECTOR_URL="https://collect.example.com" \
UPTIMIZR_API_KEY="utk_…" \
npx @uptimizr/mcp
```

No build or clone required — `npx` fetches the published package. Set the two environment variables
to point at **your** collector; nothing is sent anywhere else.

| Environment variable     | Required | Notes                                              |
| ------------------------ | -------- | -------------------------------------------------- |
| `UPTIMIZR_COLLECTOR_URL` | yes      | Base URL of **your** collector.                    |
| `UPTIMIZR_API_KEY`       | yes      | Your project API key (`x-api-key`), read-only use. |

## Configure an MCP client

Most MCP clients launch the server over stdio with the same shape — a `command`, `args`, and the two
`env` vars. Point `UPTIMIZR_COLLECTOR_URL` at a local collector (`http://localhost:4318`) for
development or your deployed collector in production.

### Claude Desktop / VS Code / Cursor

```jsonc
{
  "mcpServers": {
    "uptimizr": {
      "command": "npx",
      "args": ["-y", "@uptimizr/mcp"],
      "env": {
        "UPTIMIZR_COLLECTOR_URL": "https://collect.example.com",
        "UPTIMIZR_API_KEY": "utk_…",
      },
    },
  },
}
```

### GitHub Copilot CLI

Add the same server to `~/.copilot/mcp-config.json` (create the file if it doesn't exist), then
restart the CLI so it loads the tools:

```jsonc
{
  "mcpServers": {
    "uptimizr": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@uptimizr/mcp"],
      "env": {
        "UPTIMIZR_COLLECTOR_URL": "http://localhost:4318",
        "UPTIMIZR_API_KEY": "utk_…",
      },
      "tools": ["*"],
    },
  },
}
```

Once connected, ask in natural language: _"Using uptimizr, what were the most-clicked meshes this
week and how's the average FPS?"_ — the agent picks the right tools and answers from your data.

## Tools

The catalog is **generated from the semantic metric registry** in `@uptimizr/metrics`
([ADR 0051](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0051-ai-first-analytics-layer.md)):
every aggregation the collector serves on a read endpoint is a tool — **69** of them — so an agent
sees the whole read surface rather than a hand-picked subset. Each tool's description carries the
metric's interpretation notes and caveats (sample-size warnings, which capture channel has to be
enabled), and each declares an MCP **output schema** describing the rows it returns, so a client can
parse a result without guessing.

Most tools accept an optional time range (`since` / `until`, epoch ms) plus the filters their
endpoint supports (`scene`, `session`, `source`, `bins`, `cellSize`, `limit`, `cameraMode`,
`region`, …). `session_meta`, `session_trajectory` and `scene_representation` take a required id.

### Sessions & orientation

| Tool                   | Endpoint                                 | Returns                 |
| ---------------------- | ---------------------------------------- | ----------------------- |
| `list_sessions`        | `/api/v1/sessions`                       | Recent sessions.        |
| `session_meta`         | `/api/v1/sessions/:id/meta`              | Session descriptor.     |
| `scene_representation` | `/api/v1/scenes/:sceneId/representation` | Scene representation.   |
| `list_scenes`          | `/api/v1/scenes`                         | Active scenes.          |
| `timeseries`           | `/api/v1/timeseries`                     | Event volume over time. |
| `event_counts`         | `/api/v1/event-counts`                   | Counts per event type.  |

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

## Resources

The server also exposes read-only [MCP resources](https://modelcontextprotocol.io/docs/concepts/resources)
so an agent can **self-discover** what it can ask instead of guessing:

| Resource URI              | Type               | Contents                                                                                                                                                                                                                                             |
| ------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uptimizr://capabilities` | `application/json` | A machine-readable descriptor: schema version, the canonical **event types**, the **tool catalog**, the **parameter semantics** glossary, and `metrics` — the collector's whole [semantic metric registry](#the-metric-registry). No collector call. |
| `uptimizr://scenes`       | `application/json` | The **live** list of scene ids with recent activity — the valid values for the `scene` parameter. Fetched via the read-only query API.                                                                                                               |

Point an agent at `uptimizr://capabilities` first: it enumerates every tool, its parameters, and
what each parameter means, so the agent can plan a query without trial and error.

### The metric registry

`uptimizr://capabilities` carries a `metrics` array — the collector's **semantic metric registry**
serialised for agents. For every metric it gives:

| Field                    | What it tells an agent                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grain`                  | What **one row** is: a project, a scene, a session, a mesh, a bin, a voxel, a bucket.                                                                                                                        |
| `columns`                | Per-column description and **unit** (`ms`, `fps`, `count`, `ratio`, `world-units`, …), plus which column is the measure to rank by and which names the row.                                                  |
| `row`                    | The **JSON Schema** of a result row, so a client with no Zod can still validate or shape it.                                                                                                                 |
| `filters` / `dimensions` | The parameters it accepts and the dimensions its rows are keyed by.                                                                                                                                          |
| `limits`                 | The registry-declared row caps, so nothing asks for an unbounded payload.                                                                                                                                    |
| `interpretation`         | How to read the result — what a high or low value actually means.                                                                                                                                            |
| `caveats`                | Small-sample, sampling-rate and capture-gating warnings. **Read these before quoting a number.**                                                                                                             |
| `sourceChannels`         | The capture channels ([ADR 0012](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0012-capture-fidelity-dials.md)) that feed it — if a channel is off, the metric is empty by design, not by accident. |
| `related` / `comparable` | Metrics worth reading alongside it, and which column's change is "the" change.                                                                                                                               |

## OpenAPI

The collector serves an **OpenAPI 3.1** description of its read API — no key required, because it is
documentation and contains no project data:

```bash
curl https://collect.example.com/api/v1/openapi.json
```

It is generated from the same metric registry, so it lists exactly the aggregations that collector
can compute: one path per endpoint, every parameter with the schema that actually validates it, and
a `200` response schema per metric. The semantics OpenAPI has no vocabulary for ride along as vendor
extensions on each operation — `x-uptimizr-grain`, `x-uptimizr-units`, `x-uptimizr-caveats`,
`x-uptimizr-interpretation`, `x-uptimizr-source-channels`, `x-uptimizr-limits`,
`x-uptimizr-dimensions`, `x-uptimizr-related` and `x-uptimizr-comparable`.

That makes the collector consumable by anything that speaks OpenAPI without MCP at all — generate a
typed client, point an API explorer at it, or hand the document to an agent framework:

```bash
npx openapi-typescript https://collect.example.com/api/v1/openapi.json -o collector.d.ts
```

Authenticate ordinary calls with the `apiKey` security scheme the document declares: the `x-api-key`
header, using a key with the `query` capability.

## Prompts

Curated [MCP prompts](https://modelcontextprotocol.io/docs/concepts/prompts) package common analyses
as one-click templates. Each renders a message that steers the agent to call the right read-only
tools in a sensible order — the agent runs the tools; the prompt just frames the task.

| Prompt                | Argument | What it does                                                                                                                                  |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `weekly_scene_health` | `scene?` | A 7-day health report: traffic, event mix, FPS, and top meshes (`event_counts`, `timeseries`, `perf_summary`, `top_meshes`, `list_sessions`). |
| `attention_hotspots`  | `scene`  | Where visitors look and click: `camera_heatmap`, `flow_links`, `click_rays`, `top_meshes`.                                                    |
| `xr_comfort_review`   | `scene?` | VR/AR comfort & drop-off: `xr_rotation`, `xr_locomotion`, `xr_abandonment`, `xr_sources`.                                                     |

## Transport & roadmap

The server speaks **stdio** — the transport MCP clients (Claude Desktop, VS Code, Cursor, Copilot
CLI) launch. A remote **Streamable HTTP** transport (so browser/remote MCP clients could reach a
self-hosted collector) is a tracked follow-up and is only worth adding behind proper auth
([ADR 0050](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0050-in-browser-analytics-assistant.md) §7).

## Programmatic use

The package also exports its building blocks for embedding in your own server:

```ts
import { createCollectorClient, createMcpServer, readMcpConfig } from "@uptimizr/mcp";
```

The read-only tool catalog and the `GET`-only collector client come from the framework-agnostic
[`@uptimizr/agent-core`](https://www.npmjs.com/package/@uptimizr/agent-core) package (re-exported
here for convenience). If you're building a non-MCP agent — a browser assistant, a Node service, a
CLI, a bot — depend on `@uptimizr/agent-core` directly: it also ships a headless LLM
provider-adapter interface and tool-calling loop over the same catalog.
