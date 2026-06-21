/**
 * Browser-safe entry point for `@uptimizr/db` (ADR 0020).
 *
 * The package's root `index.js` re-exports Node-only helpers (`metadata.ts` pulls
 * in `node:crypto`), so importing the root would drag Node code into a browser
 * bundle. This subpath (`@uptimizr/db/query`) exposes ONLY the pure, isomorphic
 * pieces — the dialect-agnostic query builders, the DuckDB dialect, the option /
 * row types, and the engine-neutral event-row mapping — all of which depend only
 * on `@uptimizr/schema`. It carries no `node:`/DOM imports and is safe to bundle
 * into a Service Worker or the browser (e.g. the in-browser DuckDB-Wasm demo
 * store, see `docs/phases/demo-in-browser-design.md`).
 *
 * Do NOT add re-exports here that transitively import Node built-ins.
 */

// Dialect-agnostic option/row types + the QuerySpec contract.
export * from "./types.js";

// Dialect interface + shared WHERE-clause helpers.
export * from "./dialect.js";

// The DuckDB dialect (the OSS default engine).
export * from "./duckdbDialect.js";

// Every `build*` aggregation (renders a QuerySpec for a given Dialect).
export * from "./aggregations.js";

// Engine-neutral event → row mapping (isomorphic; imports only @uptimizr/schema).
export {
  toEventRow,
  formatUtcTimestamp,
  toNodeSampleRow,
  nodeSampleRowToEvent,
} from "../events.js";
export type { EventRow, NodeSampleRow, SessionMeta } from "../events.js";

// The DuckDB schema DDL. `migrations.ts` only imports the `DuckdbClient` *type*
// (erased at runtime), so the statement array is browser-safe to replay into a
// DuckDB-Wasm database. Re-exported here so the in-browser store stays a single
// source of truth with the Node store (no duplicated/drifting schema).
export { DUCKDB_MIGRATIONS } from "../duckdb/migrations.js";
