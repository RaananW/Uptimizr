import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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

export default defineConfig({
  // The react plugin only transforms `.tsx`; the non-React engines are untouched.
  plugins: [react(), sceneProjectsPlugin()],
  // Read VITE_* vars from the repo-root `.env` so the playground shares the same
  // env file as the rest of the stack (no separate `.env.local` to maintain).
  envDir: "../..",
  // A-Frame, react-three-fiber and the three connector all bundle three.js; dedupe
  // so a single copy is shared (mismatched copies break instanceof checks).
  resolve: { dedupe: ["three"] },
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
});
