// Cross-engine "gallery" scene (PlayCanvas): a first-person walkable room (reusing
// the shared walkable controller + NPC) where three real glTF models — Khronos
// `ToyCar` (CC0), `Fox` and `GlamVelvetSofa` (CC BY 4.0) — stand on pedestals
// instead of the demo boxes. Reuses the shared PlayCanvas connector wiring via
// `createPlayCanvasEngineModule`; only the model loading/placement is custom.

import * as pc from "playcanvas";

import {
  createPlayCanvasEngineModule,
  type PlayCanvasSceneSetup,
} from "../../engines/playcanvas.js";
import { buildWalkableScene } from "../../engines/playcanvas-walkable.js";
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

/** Load a glb, normalize it to `size`, seat it on the pedestal at (x, z); returns its part names. */
async function loadModel(
  app: pc.Application,
  model: GalleryModel,
  x: number,
  z: number,
): Promise<string[]> {
  const asset = new pc.Asset(model.name, "container", { url: model.url });
  app.assets.add(asset);
  await new Promise<void>((resolve, reject) => {
    asset.once("load", () => resolve());
    asset.once("error", (err: string) => reject(new Error(err)));
    app.assets.load(asset);
  });
  const container = asset.resource as pc.ContainerResource;
  const entity = container.instantiateRenderEntity();
  entity.name = `model-${model.name}`;
  app.root.addChild(entity);
  app.root.syncHierarchy();

  const meshInstances = (entity.findComponents("render") as pc.RenderComponent[]).flatMap(
    (r) => r.meshInstances,
  );
  const aabb = new pc.BoundingBox();
  const first = meshInstances[0];
  if (first) {
    aabb.copy(first.aabb);
    for (let i = 1; i < meshInstances.length; i++) {
      const mi = meshInstances[i];
      if (mi) aabb.add(mi.aabb);
    }
  }
  const center = aabb.center;
  const size = aabb.halfExtents.clone().mulScalar(2);
  const minY = center.y - aabb.halfExtents.y;
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = model.size / maxDim;
  entity.setLocalScale(scale, scale, scale);
  // Centre horizontally on the pedestal and sit the model's base on its top (y=1).
  entity.setPosition(x - center.x * scale, 1 - minY * scale, z - center.z * scale);

  const names: string[] = [];
  const collect = (e: pc.Entity): void => {
    if (e.name) names.push(e.name);
    for (const child of e.children) if (child instanceof pc.Entity) collect(child);
  };
  collect(entity);
  return names;
}

async function buildGalleryScene(
  canvas: HTMLCanvasElement,
  _ctx: EngineMountContext,
): Promise<PlayCanvasSceneSetup> {
  const walkable = buildWalkableScene(canvas, { skipDefaultItems: true });

  // PlayCanvas PBR needs more fill than babylon/three (no IBL/skybox here): lift the
  // ambient and add a strong key light so the metallic models aren't near-black.
  walkable.app.scene.ambientLight = new pc.Color(0.28, 0.3, 0.36);
  const key = new pc.Entity("galleryKey");
  key.addComponent("light", { type: "directional", intensity: 1.4 });
  key.setEulerAngles(55, -25, 0);
  walkable.app.root.addChild(key);
  const fill = new pc.Entity("galleryFill");
  fill.addComponent("light", { type: "directional", intensity: 0.6 });
  fill.setEulerAngles(25, 150, 0);
  walkable.app.root.addChild(fill);

  const pickable = new Set<string>();
  await Promise.all(
    MODELS.map(async (model, i) => {
      const spot = walkable.itemSpots[DISPLAY_SPOTS[i] ?? i];
      if (!spot) return;
      const names = await loadModel(walkable.app, model, spot[0], spot[1]);
      for (const name of names) pickable.add(name);
    }),
  );

  return {
    app: walkable.app,
    camera: walkable.camera,
    flashMaterials: walkable.materials,
    // Pick any entity that belongs to one of the loaded models.
    isPickable: (name) => pickable.has(name),
    pickEvent: "model_part_picked",
    cameraType: "free",
    nodeSampling: { npc: { hz: 5, include: "*" } },
    actors: { npc: "npc" },
    disposeScene: () => walkable.dispose(),
  };
}

export const engine = createPlayCanvasEngineModule({ build: buildGalleryScene });
