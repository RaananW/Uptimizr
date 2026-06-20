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

## Run

```bash
UPTIMIZR_COLLECTOR_URL="https://collect.example.com" \
UPTIMIZR_API_KEY="utk_…" \
npx @uptimizr/mcp
```

| Environment variable     | Required | Notes                                       |
| ------------------------ | -------- | ------------------------------------------- |
| `UPTIMIZR_COLLECTOR_URL` | yes      | Base URL of **your** collector.             |
| `UPTIMIZR_API_KEY`       | yes      | Your project API key (`x-api-key`), read-only use. |

## Configure an MCP client

Most MCP clients (Claude Desktop, VS Code, etc.) launch the server over stdio:

```jsonc
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

All tools accept an optional time range (`since` / `until`, epoch ms) and the filters the underlying
endpoint supports (`scene`, `session`, `source`, `bins`, `cellSize`, `limit`, …).

| Tool                   | Endpoint                            | Returns                            |
| ---------------------- | ----------------------------------- | ---------------------------------- |
| `list_sessions`        | `/api/v1/sessions`                  | Recent sessions.                   |
| `pointer_heatmap`      | `/api/v1/heatmaps/pointer`          | 2D pointer heatmap bins.           |
| `world_heatmap`        | `/api/v1/heatmaps/world`            | 3D world-space pointer voxels.     |
| `camera_heatmap`       | `/api/v1/heatmaps/camera`           | View-direction (spherical) bins.   |
| `click_rays`           | `/api/v1/heatmaps/click-rays`       | View-gated click rays.             |
| `flow_links`           | `/api/v1/heatmaps/flow`             | Gaze→mesh flow links.              |
| `top_meshes`           | `/api/v1/meshes/top`                | Most-interacted meshes.            |
| `perf_summary`         | `/api/v1/perf`                      | FPS summary (avg/min/p50).         |
| `list_scenes`          | `/api/v1/scenes`                    | Active scenes.                     |
| `timeseries`           | `/api/v1/timeseries`                | Event-volume buckets over time.    |
| `event_counts`         | `/api/v1/event-counts`              | Per-event-type counts.             |
| `session_meta`         | `/api/v1/sessions/:id/meta`         | Coarse session descriptor.         |
| `scene_representation` | `/api/v1/scenes/:id/representation` | Registered proxy geometry, if any. |

## Programmatic use

The package also exports its building blocks for embedding in your own server:

```ts
import { createCollectorClient, createMcpServer, readMcpConfig } from "@uptimizr/mcp";
```
