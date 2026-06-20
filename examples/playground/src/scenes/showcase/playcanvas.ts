// Cross-engine "showcase" scene (PlayCanvas): an orbit/viewer camera framing a
// real glTF model (Khronos `ToyCar`, CC0) instead of the demo boxes. Reuses the
// shared PlayCanvas connector wiring via `createPlayCanvasEngineModule` — only
// scene-building (load + frame the model) is custom here.

import * as pc from "playcanvas";

import { createPlayCanvasEngineModule, type PlayCanvasSceneSetup } from "../../engines/playcanvas.js";
import type { EngineMountContext } from "../../engine.js";
import { assetUrl } from "../../assets.js";

const MODEL_URL = assetUrl("models/ToyCar.glb");
const TARGET_SIZE = 2.5;

/** A minimal drag-to-orbit / wheel-to-dolly controller around `target`. */
function attachOrbit(
  canvas: HTMLCanvasElement,
  camera: pc.Entity,
  target: pc.Vec3,
  startRadius: number,
): void {
  let radius = startRadius;
  let azimuth = 0.6;
  let polar = 0.5;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function applyPose(): void {
    const cp = Math.cos(polar);
    camera.setPosition(
      target.x + radius * cp * Math.sin(azimuth),
      target.y + radius * Math.sin(polar),
      target.z + radius * cp * Math.cos(azimuth),
    );
    camera.lookAt(target);
  }
  applyPose();

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener("pointerup", () => {
    dragging = false;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    azimuth -= (e.clientX - lastX) * 0.005;
    polar = Math.max(0.05, Math.min(1.45, polar + (e.clientY - lastY) * 0.005));
    lastX = e.clientX;
    lastY = e.clientY;
    applyPose();
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      radius = Math.max(startRadius * 0.5, Math.min(startRadius * 4, radius + Math.sign(e.deltaY) * 0.4));
      applyPose();
      e.preventDefault();
    },
    { passive: false },
  );
}

async function buildShowcaseScene(
  canvas: HTMLCanvasElement,
  _ctx: EngineMountContext,
): Promise<PlayCanvasSceneSetup> {
  const app = new pc.Application(canvas, {
    mouse: new pc.Mouse(canvas),
    touch: new pc.TouchDevice(canvas),
    keyboard: new pc.Keyboard(window),
  });
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);
  window.addEventListener("resize", () => app.resizeCanvas());

  const camera = new pc.Entity("mainCamera");
  camera.addComponent("camera", {
    clearColor: new pc.Color(0.051, 0.063, 0.094),
    fov: 55,
    nearClip: 0.05,
    farClip: 100,
  });
  // The ToyCar's windshield is a transmission/refraction ("Glass") material that
  // samples the scene color grabpass; enable it so PlayCanvas provides uSceneColorMap.
  camera.camera?.requestSceneColorMap(true);
  app.root.addChild(camera);

  const key = new pc.Entity("keyLight");
  key.addComponent("light", { type: "directional", intensity: 1.4 });
  key.setEulerAngles(50, -40, 0);
  app.root.addChild(key);
  const fill = new pc.Entity("fillLight");
  fill.addComponent("light", { type: "directional", intensity: 0.5 });
  fill.setEulerAngles(20, 140, 0);
  app.root.addChild(fill);

  const groundMat = new pc.StandardMaterial();
  groundMat.diffuse = new pc.Color(0.11, 0.13, 0.18);
  groundMat.update();
  const ground = new pc.Entity("ground");
  ground.addComponent("render", { type: "plane", material: groundMat });
  ground.setLocalScale(8, 1, 8);
  app.root.addChild(ground);

  // Load the vendored glb as a container asset, instantiate its render entity, and
  // normalize it to a fixed display size sitting on the ground (Khronos models
  // vary wildly in scale).
  const asset = new pc.Asset("ToyCar", "container", { url: MODEL_URL });
  app.assets.add(asset);
  await new Promise<void>((resolve, reject) => {
    asset.once("load", () => resolve());
    asset.once("error", (err: string) => reject(new Error(err)));
    app.assets.load(asset);
  });
  const container = asset.resource as pc.ContainerResource;
  const model = container.instantiateRenderEntity();
  app.root.addChild(model);
  app.root.syncHierarchy();

  const meshInstances = (model.findComponents("render") as pc.RenderComponent[]).flatMap(
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
  const size = aabb.halfExtents.clone().mulScalar(2);
  const center = aabb.center.clone();
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = TARGET_SIZE / maxDim;
  const framedHeight = (size.y * scale) / 2;
  model.setLocalScale(scale, scale, scale);
  model.setPosition(-center.x * scale, -center.y * scale + framedHeight, -center.z * scale);

  attachOrbit(canvas, camera, new pc.Vec3(0, framedHeight, 0), TARGET_SIZE * 1.8);
  app.start();

  return {
    app,
    camera,
    // Any named model mesh is pickable (the ground is not).
    isPickable: (name) => name.length > 0 && name !== "ground",
    pickEvent: "model_part_picked",
    cameraType: "arc-rotate",
  };
}

export const engine = createPlayCanvasEngineModule({
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
