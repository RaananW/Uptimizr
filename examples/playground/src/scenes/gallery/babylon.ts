// Cross-engine "gallery" scene (Babylon.js): a first-person walkable room (reusing
// the shared walkable controller + NPC) where three real glTF models — Khronos
// `ToyCar` (CC0), `Fox` and `GlamVelvetSofa` (CC BY 4.0) — stand on pedestals
// instead of the demo boxes. Reuses the shared Babylon connector wiring via
// `createBabylonEngineModule`; only the model loading/placement is custom.

import "@babylonjs/loaders/glTF";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import type { Engine } from "@babylonjs/core/Engines/engine.js";
import type { Scene as BabylonScene } from "@babylonjs/core/scene.js";

import { createBabylonEngineModule, type BabylonSceneSetup } from "../../engines/babylon.js";
import { buildWalkableScene } from "../../engines/babylon-walkable.js";
import type { EngineMountContext } from "../../engine.js";
import { assetUrl } from "../../assets.js";

interface GalleryModel {
  readonly name: string;
  readonly url: string;
  readonly size: number;
}

const MODELS: GalleryModel[] = [
  { name: "toycar", url: assetUrl("models/ToyCar.glb"), size: 2.4 },
  { name: "fox", url: assetUrl("models/Fox.glb"), size: 2.8 },
  { name: "sofa", url: assetUrl("models/GlamVelvetSofa.glb"), size: 2.8 },
];

// Pedestal indices (into the walkable's `itemSpots`) to display the models on —
// the three nearest the first-person spawn, so the exhibits are framed on entry.
const DISPLAY_SPOTS = [4, 3, 2];

/**
 * Load a glb into the scene, normalize it to `targetSize`, and seat it on the
 * pedestal at (x, z) (pedestal top is y=1). Returns the model's mesh names so the
 * scene can mark them pickable.
 */
async function loadModel(
  scene: BabylonScene,
  model: GalleryModel,
  x: number,
  z: number,
): Promise<string[]> {
  const container = await LoadAssetContainerAsync(model.url, scene);
  container.addAllToScene();

  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  const meshNames: string[] = [];
  for (const mesh of container.meshes) {
    if (mesh.getTotalVertices() === 0) continue;
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, box.minimumWorld);
    max = Vector3.Maximize(max, box.maximumWorld);
    meshNames.push(mesh.name);
  }
  const size = max.subtract(min);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = model.size / maxDim;
  const center = min.add(max).scale(0.5);

  const root = new TransformNode(`model-${model.name}`, scene);
  for (const node of container.rootNodes) node.parent = root;
  root.scaling.setAll(scale);
  // Centre horizontally on the pedestal and sit the model's base on its top (y=1).
  root.position.set(x - center.x * scale, 1 - min.y * scale, z - center.z * scale);
  return meshNames;
}

async function buildGalleryScene(
  engine: Engine,
  ctx: EngineMountContext,
): Promise<BabylonSceneSetup> {
  const { scene, camera, itemSpots } = buildWalkableScene(engine, ctx.canvas, {
    skipDefaultItems: true,
  });

  // A soft key light flatters the PBR models beyond the room's hemispheric fill.
  const key = new DirectionalLight("galleryKey", new Vector3(-0.4, -1, 0.3), scene);
  key.intensity = 0.7;

  const pickable = new Set<string>();
  await Promise.all(
    MODELS.map(async (model, i) => {
      const spot = itemSpots[DISPLAY_SPOTS[i] ?? i];
      if (!spot) return;
      const names = await loadModel(scene, model, spot[0], spot[1]);
      for (const name of names) pickable.add(name);
    }),
  );

  return {
    scene,
    camera,
    // Pick any mesh that belongs to one of the loaded models.
    isPickable: (name) => pickable.has(name),
    pickEvent: "model_part_picked",
    nodeSampling: { npc: { hz: 5, include: "*" } },
    actors: { npc: "npc" },
  };
}

export const engine = createBabylonEngineModule({ build: buildGalleryScene });
