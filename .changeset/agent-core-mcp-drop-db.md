---
"@uptimizr/agent-core": patch
"@uptimizr/mcp": patch
---

Drop the `@uptimizr/db` dependency. Both packages read the metric registry, which now ships as the
dependency-free `@uptimizr/metrics`; neither ever opened a database. `npm i @uptimizr/react` (which
depends on `@uptimizr/agent-core`) and `npx @uptimizr/mcp` therefore no longer download
`@duckdb/node-api`, a ~37 MB native binding they could not use. No behaviour, API or tool-catalog
change — the same 69 tools with the same names, input schemas and output schemas.

A new `dependencies.test.ts` in each package fails the build if `@uptimizr/db`, or any package with
a native/optional binary dependency, becomes reachable from `dependencies` / `peerDependencies`
again; `@uptimizr/agent-core`'s esbuild browser-bundle test continues to prove the same thing from
the bundler's side.
