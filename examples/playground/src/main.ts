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

async function main(): Promise<void> {
  const scene = resolveActiveScene();
  const engineId = resolveEngineForScene(scene);
  wireSceneSelector(scene.id);
  wireEngineSelector(engineId, scene);
  const { engine } = await loadEngine(scene, engineId);
  await runPlayground(engine, scene);
}

void main();
