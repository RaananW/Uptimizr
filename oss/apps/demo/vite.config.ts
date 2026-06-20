import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The in-browser demo (`demo.uptimizr.com`). A single-origin Vite app that hosts
 * the welcome/prepare flow and a split view of the (pre-built) playground and
 * dashboard, both served from `public/` so they share this origin. The dashboard
 * talks to a service-worker collector shim backed by DuckDB-Wasm running in this
 * page — there is no backend.
 *
 * `public/playground` and `public/dashboard` are produced by
 * `scripts/prepare-embeds.mjs` (run via the `predev`/`prebuild` hooks) and are
 * git-ignored build output.
 */
export default defineConfig({
  // The react plugin only transforms `.tsx`.
  plugins: [react()],
  // Served at the subdomain root in production.
  base: "/",
  // Bundle DuckDB-Wasm's worker as an ES module worker.
  worker: { format: "es" },
  server: { port: 4320, strictPort: true },
  preview: { port: 4320, strictPort: true },
  // DuckDB-Wasm ships its own pre-bundled worker/wasm assets; let Vite serve them
  // as URL assets rather than trying to pre-bundle the package.
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
});
