// Babylon Lite engine module: builds the demo scene with Lite's functional /
// data-oriented WebGPU API, starts the `@uptimizr/babylon-lite` connector, and
// exposes replay + in-scene heatmap glue. The shared shell (src/shell.ts) owns
// all of the surrounding UI.
//
// Unlike the class-based Babylon module, Lite is a set of free functions over
// context structs: `createEngine` → `createSceneContext` → add meshes/lights →
// `registerScene` → `startEngine`. Lite is WebGPU-only.

import {
  addToScene,
  attachControl,
  createArcRotateCamera,
  createBox,
  createDirectionalLight,
  createEngine,
  createGround,
  createHemisphericLight,
  createSceneContext,
  createStandardMaterial,
  disposeEngine,
  registerScene,
  resizeSurface,
  startEngine,
  stopEngine,
} from "@babylonjs/lite";
import type { ArcRotateCamera, EngineContext, Mesh, SceneContext } from "@babylonjs/lite";

import { createScenePicker, scanSceneProxy, trackSceneAsync } from "@uptimizr/babylon-lite";
import { showWorldHeatmap } from "@uptimizr/heatmap/babylon-lite";

import {
  BOX_COLORS,
  COMMON_CAPTURE_FEATURES,
  type CaptureFeature,
  type EngineInstance,
  type EngineModule,
  type EngineMountContext,
} from "../engine.js";

// The Lite connector captures the universal channels (no WebGL context-loss) plus
// the opt-in, off-by-default heavy channels: camera … perf, then
// meshVisibility / hoverDwell / resourceSample.
const CAPTURE_FEATURES: CaptureFeature[] = [
  ...COMMON_CAPTURE_FEATURES.slice(0, 6),
  ...COMMON_CAPTURE_FEATURES.slice(7), // meshVisibility … gaze
];

async function buildScene(engine: EngineContext): Promise<{
  scene: SceneContext;
  camera: ArcRotateCamera;
  boxes: Mesh[];
}> {
  const scene = createSceneContext(engine);
  scene.clearColor = { r: 0.043, g: 0.055, b: 0.078, a: 1 };

  const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 3, 16, { x: 0, y: 1, z: 0 });
  scene.camera = camera;
  addToScene(scene, camera);
  attachControl(camera, engine.canvas as HTMLCanvasElement, scene);

  addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));
  addToScene(scene, createDirectionalLight([-0.5, -1, -0.7], 0.7));

  const ground = createGround(engine, { width: 24, height: 24 });
  ground.name = "ground";
  const groundMat = createStandardMaterial();
  groundMat.diffuseColor = [0.13, 0.16, 0.22];
  ground.material = groundMat;
  // Procedural Lite meshes carry no loader bounds, so stamp the world AABB the
  // scene-proxy scan reads (the ground is a flat 24×24 plane at y=0).
  ground.boundMin = [-12, 0, -12];
  ground.boundMax = [12, 0, 12];
  addToScene(scene, ground);

  const boxes = BOX_COLORS.map((rgb, i) => {
    const box = createBox(engine, 2);
    box.name = `box-${i}`;
    const x = (i - (BOX_COLORS.length - 1) / 2) * 3.2;
    box.position.set(x, 1, 0);
    const mat = createStandardMaterial();
    mat.diffuseColor = [rgb[0], rgb[1], rgb[2]];
    box.material = mat;
    // Size-2 box centred at its position → ±1 world half-extent on each axis.
    box.boundMin = [x - 1, 0, -1];
    box.boundMax = [x + 1, 2, 1];
    addToScene(scene, box);
    return box;
  });

  await registerScene(scene);
  return { scene, camera, boxes };
}

async function mount(ctx: EngineMountContext): Promise<EngineInstance> {
  const canvas = ctx.canvas;
  const engine = await createEngine(canvas);
  const { scene, camera } = await buildScene(engine);
  await startEngine(engine);

  const onResize = (): void => resizeSurface(engine);
  window.addEventListener("resize", onResize);

  function flashMesh(name: string): void {
    const mesh = scene.meshes.find((m) => m.name === name);
    const mat = mesh?.material as { emissiveColor?: [number, number, number] } | undefined;
    if (!mat || !("emissiveColor" in mat)) return;
    mat.emissiveColor = [0.5, 0.5, 0.55];
    setTimeout(() => {
      mat.emissiveColor = [0, 0, 0];
    }, 220);
  }

  const cap = ctx.capture;
  const client = await trackSceneAsync(scene, camera, canvas, {
    projectId: ctx.projectId,
    endpoint: ctx.collectorUrl,
    flushIntervalMs: 3000,
    transport: ctx.transport,
    ...(ctx.offload ? { offload: ctx.offload } : {}),
    sampling: { camera: 10, pointerMove: 30 },
    // The swapchain backing store is DPR-scaled by default, so the GPU picker
    // wants backing-store pixels.
    pickPixelRatio: window.devicePixelRatio,
    capture: {
      camera: cap.camera,
      gaze: cap.gaze,
      pointerMove: cap.pointerMove,
      clicks: cap.clicks,
      buttons: cap.buttons,
      meshPicks: cap.meshPicks,
      perf: cap.perf,
      meshVisibility: cap.meshVisibility,
      hoverDwell: cap.hoverDwell,
      resourceSample: cap.resourceSample,
    },
    sceneDescription: "playground (babylon-lite)",
    meta: { sceneId: ctx.sceneId },
    user: { id: "anon-playground-user", traits: { demo: true } },
    debug: true,
  });

  // Live click feedback + a developer-defined `custom` event per box pick. Lite
  // picking is GPU-based and async, so this uses the same probe the connector does.
  const demoPicker = createScenePicker(scene);
  let clickCount = 0;
  const onClick = (e: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio;
    void demoPicker
      .pick((e.clientX - rect.left) * ratio, (e.clientY - rect.top) * ratio)
      .then((hit) => {
        const name = hit?.mesh;
        if (!name || !name.startsWith("box-")) return;
        flashMesh(name);
        clickCount += 1;
        ctx.onBoxPick(name);
        client.track("box_picked", { box: name, totalPicks: clickCount });
      });
  };
  canvas.addEventListener("click", onClick);

  // The Lite replay driver is imported lazily so it only ships when replay runs.
  const { createBabylonLiteReplayDriver } = await import("@uptimizr/replay/babylon-lite");

  return {
    client,
    flashMesh,
    createReplayDriver(hooks) {
      return createBabylonLiteReplayDriver({
        camera,
        onPointer: (screen, _hitPoint, hitMesh, type) => {
          if (screen) hooks.showCursor(screen, type);
          if (type === "pointer_click" && hitMesh) flashMesh(hitMesh);
        },
        onMeshInteraction: (mesh, kind) => {
          flashMesh(mesh);
          hooks.setStatus(`replay: ${kind} → ${mesh}`);
        },
        onCustom: (name, props) => {
          const box = props?.box;
          if (typeof box === "string") flashMesh(box);
          hooks.setStatus(`replay: custom "${name}" ${props ? JSON.stringify(props) : ""}`);
        },
      });
    },
    async showHeatmap(sceneId) {
      return showWorldHeatmap({
        scene,
        endpoint: ctx.collectorUrl,
        apiKey: ctx.apiKey,
        sceneId,
        cellSize: 0.5,
      });
    },
    async registerSceneProxy(sceneId) {
      const proxy = scanSceneProxy(scene, { sceneId });
      const res = await fetch(
        `${ctx.collectorUrl.replace(/\/$/, "")}/api/v1/scenes/${encodeURIComponent(sceneId)}/representation`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", "x-api-key": ctx.apiKey },
          body: JSON.stringify({ proxy, label: sceneId }),
        },
      );
      if (!res.ok) throw new Error(`Proxy registration failed (${res.status}).`);
      return proxy.meshCount;
    },
    dispose() {
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("click", onClick);
      demoPicker.dispose();
      void client.stop("manual");
      stopEngine(engine);
      disposeEngine(engine);
    },
  };
}

export const engine: EngineModule = {
  id: "babylon-lite",
  label: "Babylon Lite",
  captureFeatures: CAPTURE_FEATURES,
  capabilities: {
    sharedCanvas: true,
    capturePanel: true,
    sceneSwitch: true,
    walkable: false,
    cursorOverlay: true,
    inputSource: true,
    replay: true,
    heatmap: true,
    sceneProxy: true,
  },
  mount,
};
