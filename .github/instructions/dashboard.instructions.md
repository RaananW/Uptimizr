---
description: Dashboard (Next.js + Tailwind) conventions for the OSS analytics UI.
applyTo: "oss/apps/dashboard/**"
---

# Dashboard (Next.js + Tailwind)

The OSS analytics UI: projects, live event feed, heatmaps, and session/perf summaries.

## Conventions

- Next.js App Router + TypeScript + Tailwind CSS.
- Read data from the collector's query API (`NEXT_PUBLIC_COLLECTOR_URL`); the dashboard does not
  talk to ClickHouse/Postgres directly.
- Import shared event/query types from `@uptimizr/schema` where applicable; never redefine them.
- Keep the dashboard self-contained within `oss/` and read storage through `@uptimizr/db` (ADR 0004).

## v1 scope (abstract heatmaps)

- Projects list + live event feed.
- **2D pointer heatmap** rendered on a canvas (screen-normalized positions).
- **Camera-direction heatmap** rendered on an abstract sphere (no project `.glb` overlay in v1 —
  that's Phase 2).
- Sessions list and basic perf summary (FPS, device/GPU, asset load).
- An in-dashboard per-session replay viewer is a Phase 1 stretch / Phase 2 item.

## Quality

- Server Components by default; Client Components only where interactivity (canvas, 3D) requires.
- Keep rendering performant for high event volumes (aggregate server-side, paginate, stream).
- Don't introduce client-side persistent identifiers or analytics-on-analytics (ADR 0003).
