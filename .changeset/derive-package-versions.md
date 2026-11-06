---
"@uptimizr/mcp": patch
"@uptimizr/sdk-core": patch
---

Report the real package version: the MCP server's `initialize` identity and the `sdkVersion` stamped on every event were both frozen at `0.1.0`. `@uptimizr/mcp` now reads its `package.json` at load time, and `SDK_VERSION` is generated from `package.json` as part of `pnpm version:packages`.
