---
"@uptimizr/db": minor
---

The metric registry moved to the new, dependency-free `@uptimizr/metrics` package, and the
`@uptimizr/db/registry` subpath is removed. The subpath was never published, so no released version
of any package consumed it; importers change `@uptimizr/db/registry` to `@uptimizr/metrics`.
`@uptimizr/db` now depends on `@uptimizr/metrics` and re-exports nothing from it — the
aggregations, dialects, stores and parity harness are unchanged.

`AGGREGATION_BUILDER_NAMES` is declared as literal data in `@uptimizr/metrics` rather than derived
from this package's `build*` exports, because deriving it would make the registry depend on the
DuckDB driver again. The invariant is unchanged, only moved from the compiler to CI:
`src/__tests__/registry.test.ts` asserts at runtime that the set of `build*` exports is exactly
that list, and still parses every registry `row` schema against real DuckDB output.
