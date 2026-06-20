/**
 * Cross-engine analytics parity harness (Phase C, ADR 0020).
 *
 * Shared fixtures, golden expectations, and a tolerance-aware comparator so the
 * same aggregation builders can be proven equal across SQL engines. The OSS
 * package ships the DuckDB-vs-golden suite; the scale-tier side reuses these exports
 * to run DuckDB-vs-ClickHouse.
 */

export * from "./fixtures.js";
export * from "./compare.js";
export * from "./cases.js";
