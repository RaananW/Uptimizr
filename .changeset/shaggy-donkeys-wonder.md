---
"@uptimizr/collector-server": minor
"@uptimizr/agent-core": minor
"@uptimizr/metrics": minor
"@uptimizr/mcp": minor
"@uptimizr/db": minor
---

Session narrative: `GET /api/v1/sessions/:id/narrative` compacts one session's raw stream into an ordered, bounded account of what it did — scene changes, per-mesh dwell, interactions, perf dips, errors, capability changes, XR and the end reason, with timestamps relative to the session start and a closing totals entry. It is gated exactly like the raw event stream (`ENABLE_RAW_SESSION_RETENTION` **and** a `query:raw` key), bounded by `maxEntries` (default 200, hard cap 1000), and adds a route-local `format=text` rendering for LLM contexts alongside `full` and `table`. The compaction is the pure `buildSessionNarrative` / `renderSessionNarrativeText` in `@uptimizr/db`; its shapes, defaults and caps live in `@uptimizr/metrics`, which also gains the `session_narrative` registry entry and an `endpoint.capability` field. `@uptimizr/agent-core` splits the generated catalog into `readTools` (the `query` surface, unchanged) and a new `rawTools`, and `createMcpServer(client, { capabilities })` registers the latter only for a key that really holds `query:raw` — the `uptimizr-mcp` binary discovers that from `/api/v1/whoami` at start-up. A narrative is a projection, never the stream: no visitor hash, URL or page metadata, no positions or rays, no device detail beyond the rendering engine, and custom-event property keys only (ADR 0003).
