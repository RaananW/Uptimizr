import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

/** Matches DuckDB-Wasm's pre-built worker scripts by filename. */
const DUCKDB_WORKER_RE = /duckdb-browser-[^/]*\.worker[^/]*\.js$/;

/** Drop the dangling `//# sourceMappingURL=…` comment from a worker source. */
const stripSourceMappingURL = (text: string): string =>
  text.replace(/\/\/# sourceMappingURL=[^\n]*\n?/g, "");

/**
 * DuckDB-Wasm's pre-built worker scripts end with a `//# sourceMappingURL=…map`
 * comment, but the matching `.map` isn't shipped (we import the worker via
 * `?url`, so only the `.js` is emitted). Each worker spawn then makes the
 * browser fetch a missing map, flooding the console with "Failed to load source
 * map" 404s. Strip the dangling comment in both dev (serve the file through a
 * middleware) and build (rewrite the emitted asset).
 */
function stripDuckdbWorkerSourcemaps(): Plugin {
  return {
    name: "strip-duckdb-worker-sourcemaps",
    // Dev: the worker `?url` asset is served straight from node_modules with its
    // dangling sourcemap comment (the build-only `generateBundle` hook never runs
    // under `vite dev`). Intercept the request and serve a stripped copy.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [path = "", query = ""] = (req.url ?? "").split("?");
        // The `?url` import is resolved by Vite itself — it returns a *module*
        // whose default export is the asset URL. Intercepting that request and
        // returning the raw worker source breaks `import … from "…?url"` with
        // "does not provide an export named 'default'". Only intercept the bare
        // worker fetch (the request the browser makes to instantiate the
        // Worker) so the dangling sourcemap comment can be stripped from it.
        if (query.split("&").includes("url")) return next();
        if (!DUCKDB_WORKER_RE.test(path)) return next();
        const name = path.slice(path.lastIndexOf("/") + 1);
        let filePath: string;
        try {
          filePath = require.resolve(`@duckdb/duckdb-wasm/dist/${name}`);
        } catch {
          return next();
        }
        readFile(filePath, "utf8")
          .then((text) => {
            res.setHeader("Content-Type", "text/javascript");
            res.end(stripSourceMappingURL(text));
          })
          .catch(() => next());
      });
    },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset") continue;
        if (!DUCKDB_WORKER_RE.test(file.fileName)) continue;
        const text =
          typeof file.source === "string" ? file.source : new TextDecoder().decode(file.source);
        file.source = stripSourceMappingURL(text);
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
