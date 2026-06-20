import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared constants for the Playwright e2e harness: ports, the seeded project id,
 * and the API key. Imported by `playwright.config.ts` (to launch the servers with
 * matching env), the seed script (to provision the DuckDB store), and the specs
 * (to query back).
 *
 * The harness runs against the **DuckDB single-file store** (ADR 0020), not the
 * in-memory store, so the dashboard's analytics aggregations (heatmaps, perf, top
 * meshes, input-source breakdown, …) have real data to render. The store is
 * provisioned deterministically by `e2e/seed.ts` before the collector boots.
 */
export const COLLECTOR_PORT = 4319;
export const PLAYGROUND_PORT = 5174;
export const DASHBOARD_PORT = 3210;
export const PROJECT_ID = "e2e-project";
export const API_KEY = "utk_e2e_key";
export const COLLECTOR_URL = `http://localhost:${COLLECTOR_PORT}`;
export const PLAYGROUND_URL = `http://localhost:${PLAYGROUND_PORT}`;
export const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;

/**
 * Absolute path to the throwaway DuckDB file the e2e collector reads/writes.
 * It MUST be absolute: the seed runs with the playground package as its cwd while
 * the collector runs with its own package as cwd (both spawned via `pnpm
 * --filter`), so a relative path would resolve to two different files and the
 * collector would never see the seeded project/key. The seed recreates it fresh
 * on every run, so the suite is deterministic.
 */
export const DUCKDB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), ".tmp/e2e.duckdb");

/**
 * Engines covered by the full capture → collector → replay round-trip. All three
 * are vanilla WebGL connectors that render into the shared canvas and expose scene
 * switching + replay, so the same spec body drives each via `?engine=<id>`. (r3f
 * gets a lighter smoke test; A-Frame is excluded because it loads from a CDN.)
 */
export const FULL_FLOW_ENGINES = ["babylon", "three", "playcanvas"] as const;

/**
 * Engines exercised by the exhaustive event-capture matrix. Babylon is the
 * reference connector (it also captures keyboard `input_action` and compile
 * stalls); three + playcanvas share the common WebGL capture surface.
 */
export const CAPTURE_MATRIX_ENGINES = ["babylon", "three", "playcanvas"] as const;
