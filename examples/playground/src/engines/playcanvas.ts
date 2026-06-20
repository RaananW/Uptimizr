// PlayCanvas engine module: builds the demo scene with a tiny orbit controller,
// starts the `@uptimizr/playcanvas` connector, and exposes replay + scene-proxy
// glue. No in-scene heatmap (no PlayCanvas heatmap adapter yet).

import * as pc from "playcanvas";

import { createSceneRaycaster, scanSceneProxy, trackScene } from "@uptimizr/playcanvas";

import {
  BOX_COLORS,
  COMMON_CAPTURE_FEATURES,
  type EngineInstance,
  type EngineModule,
  type EngineMountContext,
} from "../engine.js";
import { buildWalkableScene, type WalkablePlayCanvasScene } from "./playcanvas-walkable.js";

const ORBIT_TARGET = new pc.Vec3(0, 1, 0);

function buildScene(canvas: HTMLCanvasElement): {
  app: pc.Application;
  camera: pc.Entity;
  boxMaterials: Map<string, pc.StandardMaterial>;
} {
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
    clearColor: new pc.Color(0.043, 0.055, 0.078),
    fov: 60,
    nearClip: 0.1,
    farClip: 200,
  });
  camera.setPosition(0, 8, 16);
  camera.lookAt(ORBIT_TARGET);
  app.root.addChild(camera);

  const hemi = new pc.Entity("hemiLight");
  hemi.addComponent("light", { type: "directional", intensity: 0.5 });
  hemi.setEulerAngles(60, 30, 0);
  app.root.addChild(hemi);

  const sun = new pc.Entity("sun");
  sun.addComponent("light", { type: "directional", intensity: 0.9 });
  sun.setEulerAngles(45, -40, 0);
  app.root.addChild(sun);

  const groundMat = new pc.StandardMaterial();
  groundMat.diffuse = new pc.Color(0.13, 0.16, 0.22);
  groundMat.update();
  const ground = new pc.Entity("ground");
  ground.addComponent("render", { type: "plane", material: groundMat });
  ground.setLocalScale(24, 1, 24);
  app.root.addChild(ground);

  const boxMaterials = new Map<string, pc.StandardMaterial>();
  BOX_COLORS.forEach((rgb, i) => {
    const mat = new pc.StandardMaterial();
    mat.diffuse = new pc.Color(rgb[0], rgb[1], rgb[2]);
    mat.update();
    const name = `box-${i}`;
    const box = new pc.Entity(name);
    box.addComponent("render", { type: "box", material: mat });
    box.setPosition((i - (BOX_COLORS.length - 1) / 2) * 3.2, 1, 0);
    app.root.addChild(box);
    boxMaterials.set(name, mat);
  });

  app.start();
  return { app, camera, boxMaterials };
}

// PlayCanvas core ships no OrbitControls, so the demo owns a tiny spherical
// controller: drag to orbit, wheel to dolly. Each update mutates the camera pose.
function attachOrbit(canvas: HTMLCanvasElement, camera: pc.Entity): void {
  let radius = 17.9;
  let azimuth = 0;
  let polar = 0.45;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function applyPose(): void {
    const cp = Math.cos(polar);
    camera.setPosition(
      ORBIT_TARGET.x + radius * cp * Math.sin(azimuth),
      ORBIT_TARGET.y + radius * Math.sin(polar),
      ORBIT_TARGET.z + radius * cp * Math.cos(azimuth),
    );
    camera.lookAt(ORBIT_TARGET);
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
      radius = Math.max(5, Math.min(60, radius + Math.sign(e.deltaY) * 1.2));
      applyPose();
      e.preventDefault();
    },
    { passive: false },
  );
}

async function mount(ctx: EngineMountContext): Promise<EngineInstance> {
  const canvas = ctx.canvas;
  const firstPerson = ctx.cameraMode === "first-person";

  let app: pc.Application;
  let camera: pc.Entity;
  let flashMaterials: Map<string, pc.StandardMaterial>;
  let walkable: WalkablePlayCanvasScene | null = null;
  if (firstPerson) {
    walkable = buildWalkableScene(canvas);
    app = walkable.app;
    camera = walkable.camera;
    flashMaterials = walkable.materials;
  } else {
    const built = buildScene(canvas);
    app = built.app;
    camera = built.camera;
    flashMaterials = built.boxMaterials;
    attachOrbit(canvas, camera);
  }

  function flashMesh(name: string): void {
    const mat = flashMaterials.get(name);
    if (!mat) return;
    mat.emissive = new pc.Color(0.5, 0.5, 0.55);
    mat.update();
    setTimeout(() => {
      mat.emissive = new pc.Color(0, 0, 0);
      mat.update();
    }, 220);
  }

  // PlayCanvas has no built-in picking observable, so the demo reuses the
  // connector's `createSceneRaycaster` to detect box clicks for the flash + event.
  const probe = createSceneRaycaster(app, camera);
  function pickBoxAt(clientX: number, clientY: number): string | undefined {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const hit = probe(ndcX, ndcY);
    const name = hit?.name;
    return name && (name.startsWith("box-") || name.startsWith("item-")) ? name : undefined;
  }

  let clickCount = 0;
  canvas.addEventListener("click", (e) => {
    const name = pickBoxAt(e.clientX, e.clientY);
    if (!name) return;
    flashMesh(name);
    clickCount += 1;
    ctx.onBoxPick(name);
    client.track("box_picked", { box: name, totalPicks: clickCount });
  });

  const cap = ctx.capture;
  const client = trackScene(app, camera, {
    projectId: ctx.projectId,
    endpoint: ctx.collectorUrl,
    flushIntervalMs: 3000,
    transport: ctx.transport,
    sampling: {
      camera: 10,
      pointerMove: 30,
      // Sample the NPC subtree at 10 Hz in the walkable scene (capture.nodes gates it).
      ...(firstPerson ? { nodes: { npc: { hz: 10, include: "*" } } } : {}),
    },
    // Resolve the NPC root by name (findByName); its children are walked
    // automatically and emitted with childPath (ADR 0033).
    ...(firstPerson ? { actors: { npc: "npc" } } : {}),
    capture: {
      camera: cap.camera,
      gaze: cap.gaze,
      pointerMove: cap.pointerMove,
      clicks: cap.clicks,
      buttons: cap.buttons,
      meshPicks: cap.meshPicks,
      perf: cap.perf,
      contextLoss: cap.contextLoss,
      meshVisibility: cap.meshVisibility,
      hoverDwell: cap.hoverDwell,
      resourceSample: cap.resourceSample,
      nodes: cap.nodes,
    },
    sceneDescription: `playground (playcanvas, ${ctx.cameraMode})`,
    meta: { sceneId: ctx.sceneId },
    cameraType: firstPerson ? "free" : "arc-rotate",
    user: { id: "anon-playground-user", traits: { demo: true } },
    debug: true,
  });

  const { createPlayCanvasReplayDriver } = await import("@uptimizr/replay/playcanvas");

  return {
    client,
    flashMesh,
    createReplayDriver(hooks) {
      return createPlayCanvasReplayDriver({
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
    async registerSceneProxy(sceneId) {
      const proxy = scanSceneProxy(app, { sceneId });
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
      walkable?.dispose();
      void client.stop("manual");
      app.destroy();
    },
  };
}

export const engine: EngineModule = {
  id: "playcanvas",
  label: "PlayCanvas",
  // Append the scene-actor (NPC) toggle to the shared set (walkable scene only;
  // inert in the viewer scene where no actors are declared) — ADR 0027.
  captureFeatures: [
    ...COMMON_CAPTURE_FEATURES,
    { key: "nodes", label: "Scene actors (NPC)", default: true },
  ],
  capabilities: {
    sharedCanvas: true,
    capturePanel: true,
    sceneSwitch: true,
    walkable: true,
    cursorOverlay: true,
    inputSource: true,
    replay: true,
    heatmap: false,
    sceneProxy: true,
  },
  mount,
};
