# @uptimizr/db-clickhouse

## 0.2.2

### Patch Changes

- Updated dependencies [9e22ebd]
- Updated dependencies [394d5c8]
- Updated dependencies [e5ce02c]
  - @uptimizr/schema@0.2.0
  - @uptimizr/db@0.3.0

## 0.2.1

### Patch Changes

- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.
- Updated dependencies [df5b66b]
  - @uptimizr/schema@0.1.1
  - @uptimizr/db@0.2.1

## 0.2.0

### Minor Changes

- e78029b: feat: add a single-tenant ClickHouse store (`COLLECTOR_STORE=clickhouse`) for the scale tier. Events and metadata live in one ClickHouse database (no separate service), the schema is created on first boot, and the full analytics surface returns results identical to DuckDB (verified by a cross-engine parity suite). Adds the new `@uptimizr/db-clickhouse` package and the pure `clickhouseDialect` in `@uptimizr/db`. Implements ADR 0020.

### Patch Changes

- Updated dependencies [e78029b]
  - @uptimizr/db@0.2.0
