# @uptimizr/mcp

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server over an
Uptimizr collector's query API. It lets an AI agent ask natural-language questions about your
3D analytics ("what was the most-clicked mesh this week?") and have them answered by querying
**your own** collector — nothing is sent to any third party.

The server is a thin wrapper: each tool maps one-to-one to a documented collector query endpoint
(see [integration docs](https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md)). It
performs `GET` requests only — there are **no ingestion, mutation, or raw per-session event
tools**.

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

## Tools

All tools accept an optional time range (`since` / `until`, epoch ms) and the filters the
underlying endpoint supports (`scene`, `session`, `source`, `bins`, `cellSize`, `limit`, …).

| Tool                   | Endpoint                            | Returns                                          |
| ---------------------- | ----------------------------------- | ------------------------------------------------ |
| `list_sessions`        | `/api/v1/sessions`                  | Recent sessions.                                 |
| `pointer_heatmap`      | `/api/v1/heatmaps/pointer`          | 2D pointer heatmap bins.                         |
| `world_heatmap`        | `/api/v1/heatmaps/world`            | 3D world-space pointer voxels.                   |
| `camera_heatmap`       | `/api/v1/heatmaps/camera`           | View-direction (spherical) bins.                 |
| `click_rays`           | `/api/v1/heatmaps/click-rays`       | View-gated click rays.                           |
| `flow_links`           | `/api/v1/heatmaps/flow`             | Gaze→mesh flow links.                            |
| `top_meshes`           | `/api/v1/meshes/top`                | Most-interacted meshes.                          |
| `perf_summary`         | `/api/v1/perf`                      | FPS summary (avg/min/p50).                       |
| `list_scenes`          | `/api/v1/scenes`                    | Active scenes.                                   |
| `timeseries`           | `/api/v1/timeseries`                | Event-volume buckets over time.                  |
| `event_counts`         | `/api/v1/event-counts`              | Per-event-type counts.                           |
| `session_meta`         | `/api/v1/sessions/:id/meta`         | Coarse session descriptor (no raw event stream). |
| `scene_representation` | `/api/v1/scenes/:id/representation` | Registered proxy geometry, if any.               |

## Programmatic use

```ts
import { createCollectorClient, createMcpServer, readMcpConfig } from "@uptimizr/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const client = createCollectorClient(readMcpConfig());
const server = createMcpServer(client);
await server.connect(new StdioServerTransport());
```

## Develop

```bash
pnpm --filter @uptimizr/mcp build
pnpm --filter @uptimizr/mcp typecheck
pnpm --filter @uptimizr/mcp test
```

Licensed under [Apache-2.0](./LICENSE).
