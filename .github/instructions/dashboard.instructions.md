---
description: Dashboard (Next.js + Tailwind) conventions for the OSS analytics UI.
applyTo: "oss/apps/dashboard/**"
---

# Dashboard (Next.js + Tailwind)

The OSS analytics UI: projects, live event feed, heatmaps, and session/perf summaries.

## Conventions

- Next.js App Router + TypeScript + Tailwind CSS.
- Read data only from the collector's query API. The collector URL and API key are runtime values
  from the connection bar; `NEXT_PUBLIC_COLLECTOR_URL` is a local-dev default. The dashboard never
  talks to a database directly.
- Import shared event/query types from `@uptimizr/schema` where applicable; never redefine them.
- Panels live in `@uptimizr/react` (ADR 0047); add or change a panel there, not in this app.

## Quality

- The canonical artifact is a static export, so no feature may require a Next server at runtime.
- Keep rendering performant for high event volumes (aggregate server-side, paginate, stream).
- Don't introduce client-side persistent identifiers or analytics-on-analytics (ADR 0003).
