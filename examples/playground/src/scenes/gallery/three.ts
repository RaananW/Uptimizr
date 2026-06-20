// Cross-engine "gallery" scene (three.js): a first-person walkable room (reusing
// the shared walkable controller + NPC) where three real glTF models — Khronos
// `ToyCar` (CC0), `Fox` and `GlamVelvetSofa` (CC BY 4.0) — stand on pedestals
// instead of the demo boxes. Reuses the shared three connector wiring via
// `createThreeEngineModule`; only the model loading/placement is custom.

import { Box3, DirectionalLight, Vector3 } from "three";
import type { Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { createThreeEngineModule, type ThreeSceneSetup } from "../../engines/three.js";
import { buildWalkableScene } from "../../engines/three-walkable.js";
import type { EngineMountContext } from "../../engine.js";

interface GalleryModel {
  readonly name: string;
  readonly url: string;
  readonly size: number;
}

const MODELS: GalleryModel[] = [
  { name: "toycar", url: "/models/ToyCar.glb", size: 2.4 },
  { name: "fox", url: "/models/Fox.glb", size: 2.8 },
  { name: "sofa", url: "/models/GlamVelvetSofa.glb", size: 2.8 },
];

// Pedestal indices (into the walkable's `itemSpots`) to display the models on —
// the three nearest the first-person spawn, so the exhibits are framed on entry.
const DISPLAY_SPOTS = [4, 3, 2];

/** Load a glb, normalize it to `targetSize`, and seat it on the pedestal at (x, z). */
async function loadModel(
  loader: GLTFLoader,
  model: GalleryModel,
  x: number,
  z: number,
): Promise<Object3D> {
  const gltf = await loader.loadAsync(model.url);
  const root = gltf.scene;
  root.name = `model-${model.name}`;

  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = model.size / maxDim;
  root.scale.setScalar(scale);
  // Centre horizontally on the pedestal and sit the model's base on its top (y=1).
  root.position.set(x - center.x * scale, 1 - box.min.y * scale, z - center.z * scale);
  return root;
}

async function buildGalleryScene(
  canvas: HTMLCanvasElement,
  _ctx: EngineMountContext,
): Promise<ThreeSceneSetup> {
  const walkable = buildWalkableScene(canvas, { skipDefaultItems: true });
  // three's camera defaults to looking down -z (away from the room); face it toward
  // the exhibits at spawn so the gallery is framed on entry (matches babylon/playcanvas).
  walkable.camera.rotation.set(0, Math.PI, 0);

  // A soft key light flatters the PBR models beyond the room's hemispheric fill.
  const key = new DirectionalLight(0xffffff, 0.7);
  key.position.set(6, 12, 4);
  walkable.scene.add(key);

  const loader = new GLTFLoader();
  const pickable = new Set<string>();
  await Promise.all(
    MODELS.map(async (model, i) => {
      const spot = walkable.itemSpots[DISPLAY_SPOTS[i] ?? i];
      if (!spot) return;
      const root = await loadModel(loader, model, spot[0], spot[1]);
      walkable.scene.add(root);
      walkable.pickTargets.push(root);
      root.traverse((obj) => {
        if (obj.name) pickable.add(obj.name);
      });
      pickable.add(root.name);
    }),
  );

  return {
    scene: walkable.scene,
    camera: walkable.camera,
    renderer: walkable.renderer,
    pickTargets: walkable.pickTargets,
    // Pick any object that belongs to one of the loaded models.
    isPickable: (name) => pickable.has(name),
    pickEvent: "model_part_picked",
    update: (dt) => walkable.update(dt),
    disposeScene: () => walkable.dispose(),
    cameraType: "free",
    nodeSampling: { npc: { hz: 10, include: "*" } },
    actors: { npc: "npc" },
  };
}

export const engine = createThreeEngineModule({ build: buildGalleryScene });
