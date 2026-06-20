// Cross-engine "showcase" scene (three.js): an orbit/viewer camera framing a real
// glTF model (Khronos `ToyCar`, CC0) instead of the demo boxes. Reuses the shared
// three connector wiring via `createThreeEngineModule` — only scene-building
// (load + frame the model) is custom here.

import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { createThreeEngineModule, type ThreeSceneSetup } from "../../engines/three.js";
import type { EngineMountContext } from "../../engine.js";

const MODEL_URL = "/models/ToyCar.glb";
const TARGET_SIZE = 2.5;

async function buildShowcaseScene(
  canvas: HTMLCanvasElement,
  _ctx: EngineMountContext,
): Promise<ThreeSceneSetup> {
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new Scene();
  scene.background = new Color(0x0d1018);

  const camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 100);

  const controls = new OrbitControls(camera, renderer.domElement);

  scene.add(new HemisphereLight(0xffffff, 0x35404d, 1.1));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(-4, 8, 6);
  scene.add(sun);

  const ground = new Mesh(
    new PlaneGeometry(8, 8),
    new MeshStandardMaterial({ color: new Color(0.11, 0.13, 0.18) }),
  );
  ground.name = "ground";
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Load + normalize the vendored glTF model to a fixed display size, sit it on
  // the ground, and frame the camera to it (Khronos models vary wildly in scale).
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  const model = gltf.scene;
  const bounds = new Box3().setFromObject(model);
  const size = bounds.getSize(new Vector3());
  const center = bounds.getCenter(new Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = TARGET_SIZE / maxDim;
  model.scale.setScalar(scale);
  model.position.copy(center.clone().multiplyScalar(-scale));
  model.position.y += (size.y * scale) / 2;
  scene.add(model);

  const framedHeight = (size.y * scale) / 2;
  camera.position.set(TARGET_SIZE * 1.2, framedHeight + TARGET_SIZE * 0.9, TARGET_SIZE * 1.8);
  controls.target.set(0, framedHeight, 0);
  controls.minDistance = TARGET_SIZE * 0.8;
  controls.maxDistance = TARGET_SIZE * 6;
  controls.update();

  return {
    scene,
    camera,
    renderer,
    pickTargets: [model],
    // Any named model mesh is pickable (the ground is not).
    isPickable: (name) => name.length > 0 && name !== "ground",
    pickEvent: "model_part_picked",
    cameraType: "arc-rotate",
    update: () => controls.update(),
    disposeScene: () => controls.dispose(),
  };
}

export const engine = createThreeEngineModule({
  build: buildShowcaseScene,
  capabilities: {
    sharedCanvas: true,
    capturePanel: true,
    sceneSwitch: true,
    walkable: false,
    cursorOverlay: true,
    inputSource: true,
    replay: true,
    heatmap: false,
    sceneProxy: true,
  },
});
