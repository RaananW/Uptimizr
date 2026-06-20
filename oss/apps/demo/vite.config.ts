import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * DuckDB-Wasm's pre-built worker scripts end with a `//# sourceMappingURL=…map`
 * comment, but the matching `.map` isn't shipped (we import the worker via
 * `?url`, so only the `.js` is emitted). Each worker spawn then makes the
 * browser fetch a missing map, flooding the console with "Failed to load source
 * map" 404s. Strip the dangling comment from the emitted worker assets.
 */
function stripDuckdbWorkerSourcemaps(): Plugin {
  return {
    name: "strip-duckdb-worker-sourcemaps",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset") continue;
        if (!/duckdb-browser-[^/]*\.worker[^/]*\.js$/.test(file.fileName)) continue;
        const text =
          typeof file.source === "string" ? file.source : new TextDecoder().decode(file.source);
        file.source = text.replace(/\/\/# sourceMappingURL=[^\n]*\n?/g, "");
      }
    },
  };
}

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
  plugins: [react(), stripDuckdbWorkerSourcemaps()],
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
