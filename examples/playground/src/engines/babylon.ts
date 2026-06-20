// Babylon.js engine module: builds the demo scene, starts the `@uptimizr/babylon`
// connector, and exposes replay, 3D heatmap overlay, and scene-proxy glue. The
// shared shell (src/shell.ts) owns all of the surrounding UI.

import {
  ArcRotateCamera,
  Color3,
  CreateBox,
  CreateGround,
  Engine,
  HemisphericLight,
  PointerEventTypes,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import type { Camera, Scene as BabylonScene } from "@babylonjs/core";
import { Scene } from "@babylonjs/core/scene.js";

import { scanSceneProxy, trackScene } from "@uptimizr/babylon";
import { showWorldHeatmap } from "@uptimizr/heatmap/babylon";

import {
  BOX_COLORS,
  COMMON_CAPTURE_FEATURES,
  type CaptureFeature,
  type EngineInstance,
  type EngineModule,
  type EngineMountContext,
} from "../engine.js";
import { buildWalkableScene } from "./babylon-walkable.js";

const CAPTURE_FEATURES: CaptureFeature[] = [
  ...COMMON_CAPTURE_FEATURES.slice(0, 7), // camera … contextLoss
  { key: "compileStall", label: "Compile stalls", default: true },
  ...COMMON_CAPTURE_FEATURES.slice(7), // meshVisibility … gaze
  { key: "keyboard", label: "Keyboard", default: false },
  // Scene-actor capture (ADR 0027): the walkable scene's ambient NPC is tracked
  // as a `node_transform` so replay reproduces its patrol. No-op in viewer mode
  // (the orbital scene has no moving actor).
  { key: "nodes", label: "Scene actors (NPC)", default: true },
];

function buildScene(engine: Engine): { scene: BabylonScene; camera: Camera } {
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera("camera", Math.PI / 2, Math.PI / 3, 16, Vector3.Zero(), scene);
  camera.attachControl(true);

  new HemisphericLight("light", new Vector3(0, 1, 0), scene);

  const ground = CreateGround("ground", { width: 24, height: 24 }, scene);
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = new Color3(0.13, 0.16, 0.22);
  ground.material = groundMat;

  BOX_COLORS.forEach((rgb, i) => {
    const box = CreateBox(`box-${i}`, { size: 2 }, scene);
    box.position.x = (i - (BOX_COLORS.length - 1) / 2) * 3.2;
    box.position.y = 1;
    const mat = new StandardMaterial(`box-mat-${i}`, scene);
    mat.diffuseColor = new Color3(rgb[0], rgb[1], rgb[2]);
    box.material = mat;
  });

  return { scene, camera };
}

async function mount(ctx: EngineMountContext): Promise<EngineInstance> {
  const engine = new Engine(ctx.canvas, true, { preserveDrawingBuffer: true, stencil: true });
  const { scene, camera } =
    ctx.cameraMode === "first-person" ? buildWalkableScene(engine, ctx.canvas) : buildScene(engine);
  engine.runRenderLoop(() => scene.render());
  const onResize = (): void => engine.resize();
  window.addEventListener("resize", onResize);

  // The walkable scene ships an ambient NPC (a `TransformNode` named "npc") whose
  // body + head meshes are parented to it and patrol on their own — exactly the
  // "self-moving actor" replay can't capture from visitor input (ADR 0027). Track
  // the `npc` root as a single subtree actor (ADR 0033 `include: "*"`): the
  // connector walks its children and emits each part with a `childPath`
  // ("npc-body", "npc-head"), so the whole figure is recorded from one declaration.
  // The orbital viewer scene has no such actor.
  const isWalkable = ctx.cameraMode === "first-person";

  const sceneId = ctx.sceneId;
  const cap = ctx.capture;
  const client = trackScene(scene, {
    projectId: ctx.projectId,
    endpoint: ctx.collectorUrl,
    flushIntervalMs: 3000,
    transport: ctx.transport,
    sampling: {
      camera: 10,
      pointerMove: 30,
      // Sample the NPC subtree at 10 Hz in the walkable scene (capture.nodes gates it).
      ...(isWalkable ? { nodes: { npc: { hz: 10, include: "*" } } } : {}),
    },
    // Resolve the NPC root by name (getTransformNodeByName); its children are
    // walked automatically and emitted with childPath (ADR 0033).
    ...(isWalkable ? { actors: { npc: "npc" } } : {}),
    capture: {
      camera: cap.camera,
      gaze: cap.gaze,
      pointerMove: cap.pointerMove,
      clicks: cap.clicks,
      buttons: cap.buttons,
      meshPicks: cap.meshPicks,
      perf: cap.perf,
      contextLoss: cap.contextLoss,
      compileStall: cap.compileStall,
      meshVisibility: cap.meshVisibility,
      hoverDwell: cap.hoverDwell,
      resourceSample: cap.resourceSample,
      keyboard: cap.keyboard,
      nodes: cap.nodes,
    },
    ...(ctx.keyBindings ? { keyBindings: ctx.keyBindings } : {}),
    sceneDescription: `playground (babylon, ${ctx.cameraMode})`,
    meta: { sceneId },
    user: { id: "anon-playground-user", traits: { demo: true } },
    debug: true,
  });

  function flashMesh(name: string): void {
    const mat = scene.getMeshByName(name)?.material;
    if (!(mat instanceof StandardMaterial)) return;
    mat.emissiveColor = new Color3(0.5, 0.5, 0.55);
    setTimeout(() => {
      mat.emissiveColor = Color3.Black();
    }, 220);
  }

  // Live click feedback + a developer-defined `custom` event per box pick.
  let clickCount = 0;
  scene.onPointerObservable.add((info) => {
    const mesh = info.pickInfo?.pickedMesh;
    const pickable = mesh?.name.startsWith("box-") || mesh?.name.startsWith("item-");
    if (info.type === PointerEventTypes.POINTERPICK && mesh && pickable) {
      flashMesh(mesh.name);
      clickCount += 1;
      ctx.onBoxPick(mesh.name);
      client.track("box_picked", { box: mesh.name, totalPicks: clickCount });
    }
  });

  // The Babylon replay driver is imported lazily so it only ships when replay runs.
  const { createBabylonReplayDriver } = await import("@uptimizr/replay/babylon");

  return {
    client,
    flashMesh,
    createReplayDriver(hooks) {
      return createBabylonReplayDriver({
        scene,
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
      void client.stop("manual");
      engine.dispose();
    },
  };
}

export const engine: EngineModule = {
  id: "babylon",
  label: "Babylon.js",
  captureFeatures: CAPTURE_FEATURES,
  capabilities: {
    sharedCanvas: true,
    capturePanel: true,
    sceneSwitch: true,
    walkable: true,
    cursorOverlay: true,
    inputSource: true,
    replay: true,
    heatmap: true,
    sceneProxy: true,
  },
  mount,
};
