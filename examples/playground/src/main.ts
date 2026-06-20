// Bootstrap: resolve the selected scene + engine, populate the selectors, then
// **dynamic-import only that engine's module** so the browser downloads just the
// chosen engine + its connector (each `import()` below is a separate Vite chunk).
// All shared UX lives in the shell; each engine module is a thin `mount()`.
//
// Built-in scenes (lobby/atrium) are rendered by the shared engine modules under
// `src/engines/`. Scaffolded scenes (added via `pnpm scene:new`) may ship per-engine
// override builders under `src/scenes/<sceneId>/<engineId>.{ts,tsx}`, auto-discovered
// below; when an override is absent the built-in engine module renders the scene.

import { type EngineId, type EngineModule } from "./engine.js";
import {
  resolveActiveScene,
  resolveEngineForScene,
  runPlayground,
  wireEngineSelector,
  wireSceneSelector,
} from "./shell.js";
import type { SceneDefinition } from "./scenes/catalog.js";

const builtinLoaders: Record<EngineId, () => Promise<{ engine: EngineModule }>> = {
  babylon: () => import("./engines/babylon.js"),
  "babylon-lite": () => import("./engines/babylon-lite.js"),
  three: () => import("./engines/three.js"),
  playcanvas: () => import("./engines/playcanvas.js"),
  r3f: () => import("./engines/r3f.js"),
  aframe: () => import("./engines/aframe.js"),
};

// Per-scene engine overrides: `src/scenes/<sceneId>/<engineId>.{ts,tsx}` exporting
// `{ engine }`. Matches nothing until a scene is scaffolded with custom builders.
const overrideLoaders = import.meta.glob<{ engine: EngineModule }>("./scenes/*/*.{ts,tsx}");

function loadEngine(scene: SceneDefinition, engineId: EngineId): Promise<{ engine: EngineModule }> {
  const override =
    overrideLoaders[`./scenes/${scene.id}/${engineId}.ts`] ??
    overrideLoaders[`./scenes/${scene.id}/${engineId}.tsx`];
  if (override && !scene.builtin) return override();
  return builtinLoaders[engineId]();
}

/**
 * When embedded in the demo host (a same-origin iframe), announce the active
 * scene + engine so the host can reset its single-project store whenever they
 * change — otherwise analytics from different scenes would pile into one project
 * and the dashboard would show mixed, incorrect data. No-op when run standalone.
 */
function notifyEmbedHost(sceneId: string, engineId: EngineId): void {
  if (window.parent === window) return;
  try {
    window.parent.postMessage(
      { type: "uptimizr:playground-context", sceneId, engineId },
      location.origin,
    );
  } catch {
    /* ignore cross-origin / messaging failures */
  }
}

async function main(): Promise<void> {
  const scene = resolveActiveScene();
  const engineId = resolveEngineForScene(scene);
  // Announce before loading the engine so the host can reset its store while the
  // engine chunk is still downloading (the reset lands before this scene's proxy
  // + events are registered).
  notifyEmbedHost(scene.id, engineId);
  wireSceneSelector(scene.id);
  wireEngineSelector(engineId, scene);
  const { engine } = await loadEngine(scene, engineId);
  await runPlayground(engine, scene);
}

void main();
