import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { UNITY_DIST_DIR, serveUnityBuild } from "./e2e/helpers/unity-build.js";

/**
 * Expose the scene→project bindings from `.uptimizr/projects.json` (written by the
 * seed + `pnpm scene:new`) as a virtual module, so the playground can route each
 * scene's events to its own collector project without bundling the registry file.
 * Built-in scenes fall back to the env-configured projects, so this returns `{}`
 * (and the playground still works) when no registry exists.
 *
 * Set `UPTIMIZR_DISABLE_SCENE_REGISTRY=1` to force the empty map regardless of any
 * on-disk registry. The e2e harness sets this so a developer's local
 * `.uptimizr/projects.json` can't leak in and override the harness's seeded
 * project — every scene then routes to the env-configured `VITE_PROJECT_ID`.
 */
function sceneProjectsPlugin(): Plugin {
  const virtualId = "virtual:uptimizr-scene-projects";
  const resolvedId = `\0${virtualId}`;
  const registryPath = fileURLToPath(new URL("../../.uptimizr/projects.json", import.meta.url));
  return {
    name: "uptimizr-scene-projects",
    resolveId(id) {
      return id === virtualId ? resolvedId : null;
    },
    load(id) {
      if (id !== resolvedId) return null;
      const map: Record<string, { projectId: string; apiKey: string }> = {};
      if (process.env.UPTIMIZR_DISABLE_SCENE_REGISTRY === "1") {
        return `export default ${JSON.stringify(map)};`;
      }
      try {
        const raw: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
        if (Array.isArray(raw)) {
          for (const entry of raw) {
            const sceneId = entry?.scene?.id;
            if (typeof sceneId === "string" && entry?.id && entry?.apiKey) {
              map[sceneId] = { projectId: String(entry.id), apiKey: String(entry.apiKey) };
            }
          }
        }
      } catch {
        /* no registry yet — built-in scenes use env fallback */
      }
      return `export default ${JSON.stringify(map)};`;
    },
  };
}

/**
 * Serve the headless Godot Web export of `examples/godot-web-export` (built by
 * `pnpm godot:export` into its gitignored `dist/`) under `/godot-export/` on the dev
 * server, so `godot-export-e2e.html` can boot the real engine in-page and the
 * `godot-export.spec.ts` e2e can drive the bridged tier through the shipped
 * `UptimizrGodot.gd` autoload. The export is built with the **nothreads** template,
 * so no COOP/COEP headers are needed. 404s when no export has been built (the spec
 * skips itself in that case).
 */
function godotExportPlugin(): Plugin {
  const prefix = "/godot-export/";
  const distDir = fileURLToPath(new URL("../godot-web-export/dist/", import.meta.url));
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".pck": "application/octet-stream",
    ".png": "image/png",
    ".json": "application/json",
  };
  return {
    name: "uptimizr-godot-export",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (!url.startsWith(prefix)) return next();
        const file = resolve(distDir, decodeURIComponent(url.slice(prefix.length)));
        if (!file.startsWith(distDir) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end(`no Godot export at ${url} — run 'pnpm godot:fetch && pnpm godot:export'`);
          return;
        }
        res.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
        res.setHeader("Content-Length", statSync(file).size);
        createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * Serve a locally built Unity WebGL export (`examples/unity-web-export/dist/`) at
 * `/unity-build/` for the `unity-export-e2e.html` harness + `e2e/unity-export.spec.ts`.
 * Dev-server only: the build is the maintainer's one manual step and is git-ignored,
 * so this is a no-op (the manifest 404s and the spec skips) when nothing was built.
 */
function unityBuildPlugin(): Plugin {
  return {
    name: "uptimizr-unity-build",
    configureServer(server) {
      server.middlewares.use(serveUnityBuild(UNITY_DIST_DIR));
    },
  };
}

export default defineConfig({
  // The react plugin only transforms `.tsx`; the non-React engines are untouched.
  plugins: [react(), sceneProjectsPlugin(), godotExportPlugin(), unityBuildPlugin()],
  // Read VITE_* vars from the repo-root `.env` so the playground shares the same
  // env file as the rest of the stack (no separate `.env.local` to maintain).
  envDir: "../..",
  // A-Frame, react-three-fiber and the three connector all bundle three.js; dedupe
  // so a single copy is shared (mismatched copies break instanceof checks).
  resolve: { dedupe: ["three"] },
  server: { port: 5173, strictPort: true },
  build: {
    target: "es2022",
    // Each engine is its own lazily-loaded chunk (PlayCanvas ≈ 1.9 MB, Babylon ≈ 1 MB
    // minified); that is the engine, not something to split further.
    chunkSizeWarningLimit: 2500,
  },
});
