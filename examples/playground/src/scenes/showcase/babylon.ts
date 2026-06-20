// Cross-engine "showcase" scene (Babylon.js): an orbit/viewer camera framing a
// real glTF model (Khronos `ToyCar`, CC0) instead of the demo boxes. It reuses
// the shared Babylon connector wiring via `createBabylonEngineModule` — only the
// scene-building (load + frame the model) is custom here.

import "@babylonjs/loaders/glTF";
import {
  ArcRotateCamera,
  Color3,
  CreateGround,
  DirectionalLight,
  HemisphericLight,
  LoadAssetContainerAsync,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { AbstractMesh, Engine } from "@babylonjs/core";
import { Scene } from "@babylonjs/core/scene.js";

import { createBabylonEngineModule, type BabylonSceneSetup } from "../../engines/babylon.js";
import type { EngineMountContext } from "../../engine.js";

const MODEL_URL = "/models/ToyCar.glb";

async function buildShowcaseScene(
  engine: Engine,
  _ctx: EngineMountContext,
): Promise<BabylonSceneSetup> {
  const scene = new Scene(engine);
  scene.clearColor = new Color3(0.05, 0.06, 0.09).toColor4(1);

  const camera = new ArcRotateCamera("camera", Math.PI / 3, Math.PI / 2.6, 0.6, Vector3.Zero(), scene);
  camera.attachControl(true);
  camera.wheelDeltaPercentage = 0.02;
  camera.lowerRadiusLimit = 0.15;
  camera.upperRadiusLimit = 4;

  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.9;
  hemi.groundColor = new Color3(0.2, 0.22, 0.28);
  const key = new DirectionalLight("key", new Vector3(-0.4, -1, -0.6), scene);
  key.intensity = 1.4;

  const ground = CreateGround("ground", { width: 6, height: 6 }, scene);
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.11, 0.13, 0.18);
  ground.material = groundMat;

  // Load the vendored glTF model and add it to the scene.
  const container = await LoadAssetContainerAsync(MODEL_URL, scene);
  container.addAllToScene();
  const modelMeshes = new Set(container.meshes.map((m: AbstractMesh) => m.name));

  // Khronos sample models are authored at wildly different scales (ToyCar is a few
  // centimetres). Measure the real bounds, then normalize the whole model to a
  // fixed display size and sit it on the ground so the camera framing is stable.
  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const mesh of container.meshes) {
    if (mesh.getTotalVertices() === 0) continue;
    mesh.computeWorldMatrix(true);
    const bb = mesh.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, bb.minimumWorld);
    max = Vector3.Maximize(max, bb.maximumWorld);
  }
  const center = min.add(max).scale(0.5);
  const dims = max.subtract(min);
  const maxDim = Math.max(dims.x, dims.y, dims.z) || 1;
  const target = 2.5;
  const scale = target / maxDim;

  const modelRoot = new TransformNode("modelRoot", scene);
  for (const root of container.rootNodes) root.parent = modelRoot;
  modelRoot.scaling.setAll(scale);
  // Center the model on the origin, then lift it so its base rests on the ground.
  modelRoot.position = center.scale(-scale);
  modelRoot.position.y += (dims.y * scale) / 2;

  const framedHeight = (dims.y * scale) / 2;
  camera.setTarget(new Vector3(0, framedHeight, 0));
  camera.radius = target * 1.8;
  camera.lowerRadiusLimit = target * 0.8;
  camera.upperRadiusLimit = target * 6;
  // setTarget recomputes alpha/beta from the camera's pre-framing position, which
  // leaves it looking up from below. Re-assert a high three-quarter viewing angle
  // (beta < PI/2 looks down on the model) now that the target is at mid-height.
  camera.alpha = Math.PI / 3;
  camera.beta = Math.PI / 2.8;

  return {
    scene,
    camera,
    // Any model mesh is pickable (the ground is not).
    isPickable: (name) => modelMeshes.has(name),
    pickEvent: "model_part_picked",
  };
}

export const engine = createBabylonEngineModule({
  build: buildShowcaseScene,
  capabilities: {
    sharedCanvas: true,
    capturePanel: true,
    sceneSwitch: true,
    // Viewer-only scene: no walkable variant, so the camera-mode toggle stays hidden.
    walkable: false,
    cursorOverlay: true,
    inputSource: true,
    replay: true,
    heatmap: true,
    sceneProxy: true,
  },
});
