---
"@uptimizr/schema": major
"@uptimizr/sdk-core": major
"@uptimizr/babylon": major
"@uptimizr/babylon-lite": major
"@uptimizr/three": major
"@uptimizr/r3f": major
"@uptimizr/playcanvas": major
"@uptimizr/aframe": major
"@uptimizr/replay": major
"@uptimizr/heatmap": major
"@uptimizr/react": major
"@uptimizr/agent-core": major
"@uptimizr/mcp": major
"@uptimizr/db": major
"@uptimizr/db-clickhouse": major
"@uptimizr/db-postgres": major
"@uptimizr/collector-server": major
"@uptimizr/dashboard": major
---

Uptimizr 1.0.0 — first stable release. Every package moves to 1.0.0 together; from here on the public API, the versioned event schema, and the collector's HTTP API follow semantic versioning (a breaking change is a major). Highlights since the public beta: six stable live-JS connectors (Babylon.js, Babylon Lite, three.js, react-three-fiber, PlayCanvas, A-Frame/WebXR) with per-engine capture parity and end-to-end coverage; WebXR in-scene hit resolution; three optional multi-writer stores (ClickHouse, PostgreSQL, SQL Server) behind the same `CollectorStore` contract with cross-engine parity tests; the in-browser analytics assistant with a local (WebLLM) or hosted model, tool-calling over the read-only analytics catalog, and streamed replies; and the MCP server for desktop AI clients. No wire-format or API changes are bundled with this bump — it marks the point where they become breaking.
