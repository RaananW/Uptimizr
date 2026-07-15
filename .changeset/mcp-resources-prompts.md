---
"@uptimizr/mcp": minor
---

feat(mcp): add capability resources, curated prompts, and new read tools

Evolve the read-only MCP server per ADR 0050 §7:

- **Resources** for self-discovery: `uptimizr://capabilities` (a machine-readable descriptor of
  event types, the tool catalog, and parameter semantics, sourced from the shared catalog +
  `@uptimizr/schema`) and `uptimizr://scenes` (the live scene ids for the `scene` parameter).
- **Prompts**: curated templates `weekly_scene_health`, `attention_hotspots`, and
  `xr_comfort_review` that drive the existing tools.
- **New tools** surfaced from the shared catalog: funnels, aggregate desire-line paths,
  rendering-technology breakdown, and XR spatial analytics.

The server remains strictly read-only (ADR 0003 / ADR 0017). A Streamable HTTP transport stays
deferred as a separate, auth-gated follow-up.
