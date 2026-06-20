// three.js engine module: builds the demo scene, starts the `@uptimizr/three`
// connector, and exposes replay + scene-proxy glue. No in-scene heatmap (there is
// no three heatmap adapter yet). The shared shell owns the surrounding UI.

import {
  BoxGeometry,
  Clock,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { scanSceneProxy, trackScene } from "@uptimizr/three";

import {
  BOX_COLORS,
  COMMON_CAPTURE_FEATURES,
  type EngineInstance,
  type EngineModule,
  type EngineMountContext,
} from "../engine.js";
import { buildWalkableScene, type WalkableScene } from "./three-walkable.js";

function buildScene(canvas: HTMLCanvasElement): {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  controls: OrbitControls;
  boxes: Mesh[];
} {
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new Scene();
  scene.background = new Color(0x0b0e14);

  const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 8, 16);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();

  scene.add(new HemisphereLight(0xffffff, 0x303a4a, 1.0));
  const sun = new DirectionalLight(0xffffff, 0.7);
  sun.position.set(5, 10, 7);
  scene.add(sun);

  const ground = new Mesh(
    new PlaneGeometry(24, 24),
    new MeshStandardMaterial({ color: new Color(0.13, 0.16, 0.22) }),
  );
  ground.name = "ground";
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const boxes = BOX_COLORS.map((rgb, i) => {
    const box = new Mesh(
      new BoxGeometry(2, 2, 2),
      new MeshStandardMaterial({ color: new Color(rgb[0], rgb[1], rgb[2]) }),
    );
    box.name = `box-${i}`;
    box.position.set((i - (BOX_COLORS.length - 1) / 2) * 3.2, 1, 0);
    scene.add(box);
    return box;
  });

  return { scene, camera, renderer, controls, boxes };
}

async function mount(ctx: EngineMountContext): Promise<EngineInstance> {
  const canvas = ctx.canvas;
  const firstPerson = ctx.cameraMode === "first-person";

  let scene: Scene;
  let camera: PerspectiveCamera;
  let renderer: WebGLRenderer;
  let pickTargets: Mesh[];
  let viewerControls: OrbitControls | null = null;
  let walkable: WalkableScene | null = null;
  if (firstPerson) {
    walkable = buildWalkableScene(canvas);
    ({ scene, camera, renderer, pickTargets } = walkable);
  } else {
    const built = buildScene(canvas);
    scene = built.scene;
    camera = built.camera;
    renderer = built.renderer;
    viewerControls = built.controls;
    pickTargets = built.boxes;
  }

  const clock = new Clock();
  let running = true;
  function renderLoop(): void {
    if (!running) return;
    const dt = clock.getDelta();
    if (walkable) walkable.update(dt);
    else viewerControls?.update();
    renderer.render(scene, camera);
    requestAnimationFrame(renderLoop);
  }
  requestAnimationFrame(renderLoop);

  const onResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", onResize);

  function flashMesh(name: string): void {
    const mesh = scene.getObjectByName(name);
    const mat = mesh instanceof Mesh ? mesh.material : undefined;
    if (!(mat instanceof MeshStandardMaterial)) return;
    mat.emissive.setRGB(0.5, 0.5, 0.55);
    setTimeout(() => mat.emissive.setRGB(0, 0, 0), 220);
  }

  // three has no built-in picking observable — the demo owns a raycaster for the
  // box flash + custom event (the connector raycasts independently for capture).
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  function pickBoxAt(clientX: number, clientY: number): string | undefined {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickTargets, false)[0];
    const name = hit?.object.name;
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
  const client = trackScene(scene, camera, renderer, {
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
    // Resolve the NPC root by name (scene.getObjectByName); its children are
    // walked automatically and emitted with childPath (ADR 0033).
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
    sceneDescription: `playground (three, ${ctx.cameraMode})`,
    meta: { sceneId: ctx.sceneId },
    cameraType: firstPerson ? "free" : "arc-rotate",
    user: { id: "anon-playground-user", traits: { demo: true } },
    debug: true,
  });

  const { createThreeReplayDriver } = await import("@uptimizr/replay/three");

  return {
    client,
    flashMesh,
    createReplayDriver(hooks) {
      return createThreeReplayDriver({
        // The driver's `scene` is a loose structural type (it only reads/writes the
        // camera); three's `Scene` has no index signature, so cast at the boundary.
        scene: scene as unknown as Record<string, unknown>,
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
      running = false;
      window.removeEventListener("resize", onResize);
      if (walkable) walkable.dispose();
      else viewerControls?.dispose();
      void client.stop("manual");
      renderer.dispose();
    },
  };
}

export const engine: EngineModule = {
  id: "three",
  label: "three.js",
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
