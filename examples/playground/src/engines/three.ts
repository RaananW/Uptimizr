// three.js engine module: builds the demo scene, starts the `@uptimizr/three`
// connector, and exposes replay + scene-proxy glue. No in-scene heatmap (there is
// no three heatmap adapter yet). The shared shell owns the surrounding UI.

import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Timer,
  Vector2,
  WebGLRenderer,
} from "three";
import type { Object3D } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { scanSceneProxy, trackScene } from "@uptimizr/three";

import {
  BOX_COLORS,
  COMMON_CAPTURE_FEATURES,
  type CaptureFeature,
  type EngineCapabilities,
  type EngineId,
  type EngineInstance,
  type EngineModule,
  type EngineMountContext,
} from "../engine.js";
import { buildWalkableScene } from "./three-walkable.js";

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

/**
 * What a three.js scene builder hands back to the shared `mount`: the renderer +
 * scene + camera, the objects the raycaster should consider, which mesh names are
 * pickable, per-frame `update`, teardown, plus the custom pick event and any
 * actor/node sampling. Custom scenes (e.g. a real glTF model under
 * `src/scenes/<id>/three.ts`) provide this; the connector/picking/replay/proxy
 * wiring below is shared.
 */
export interface ThreeSceneSetup {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  /** Objects the raycaster intersects (recursively) for the demo pick. */
  readonly pickTargets: Object3D[];
  /** True for mesh names that should flash + emit a pick. */
  isPickable(meshName: string): boolean;
  /** Per-frame hook (controls.update, animation mixer, walkable physics). */
  update?(dt: number): void;
  /** Scene-specific teardown (controls, walkable, mixer). */
  disposeScene?(): void;
  readonly pickEvent?: string;
  readonly cameraType?: "free" | "arc-rotate";
  readonly nodeSampling?: Record<string, { hz: number; include?: string[] | "*" }>;
  readonly actors?: Record<string, string>;
}

/** Builds the three.js scene for a mount; may load assets asynchronously. */
export type ThreeSceneBuilder = (
  canvas: HTMLCanvasElement,
  ctx: EngineMountContext,
) => ThreeSceneSetup | Promise<ThreeSceneSetup>;

/** Options for {@link createThreeEngineModule}. Only `build` is required. */
export interface ThreeEngineOptions {
  readonly build: ThreeSceneBuilder;
  readonly id?: EngineId;
  readonly label?: string;
  readonly captureFeatures?: CaptureFeature[];
  readonly capabilities?: EngineCapabilities;
}

const DEFAULT_CAPABILITIES: EngineCapabilities = {
  sharedCanvas: true,
  capturePanel: true,
  sceneSwitch: true,
  walkable: true,
  cursorOverlay: true,
  inputSource: true,
  replay: true,
  heatmap: false,
  sceneProxy: true,
};

const DEFAULT_CAPTURE_FEATURES: CaptureFeature[] = [
  ...COMMON_CAPTURE_FEATURES,
  { key: "keyboard", label: "Keyboard", default: true },
  { key: "nodes", label: "Scene actors (NPC)", default: true },
];

/** The built-in demo scene builder: orbit boxes (viewer) or the walkable room. */
function buildDemoScene(canvas: HTMLCanvasElement, ctx: EngineMountContext): ThreeSceneSetup {
  const isDemoPickable = (name: string): boolean =>
    name.startsWith("box-") || name.startsWith("item-");
  if (ctx.cameraMode === "first-person") {
    const walkable = buildWalkableScene(canvas);
    return {
      scene: walkable.scene,
      camera: walkable.camera,
      renderer: walkable.renderer,
      pickTargets: walkable.pickTargets,
      isPickable: isDemoPickable,
      update: (dt) => walkable.update(dt),
      disposeScene: () => walkable.dispose(),
      cameraType: "free",
      nodeSampling: { npc: { hz: 10, include: "*" } },
      actors: { npc: "npc" },
    };
  }
  const built = buildScene(canvas);
  return {
    scene: built.scene,
    camera: built.camera,
    renderer: built.renderer,
    pickTargets: built.boxes,
    isPickable: isDemoPickable,
    update: () => built.controls.update(),
    disposeScene: () => built.controls.dispose(),
    cameraType: "arc-rotate",
  };
}

/**
 * Build a three.js `EngineModule` around a scene builder. The default export wraps
 * {@link buildDemoScene}; custom scenes (e.g. a real glTF model) pass their own
 * `build` and reuse all of the connector/picking/replay/proxy wiring.
 */
export function createThreeEngineModule(options: ThreeEngineOptions): EngineModule {
  async function mount(ctx: EngineMountContext): Promise<EngineInstance> {
    const canvas = ctx.canvas;
    const setup = await options.build(canvas, ctx);
    const { scene, camera, renderer, pickTargets } = setup;

    const timer = new Timer();
    let running = true;
    function renderLoop(): void {
      if (!running) return;
      timer.update();
      const dt = timer.getDelta();
      setup.update?.(dt);
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
      const prev = mat.emissive.clone();
      mat.emissive.setRGB(0.5, 0.5, 0.55);
      setTimeout(() => mat.emissive.copy(prev), 220);
    }

    // three has no built-in picking observable — the demo owns a raycaster for the
    // flash + custom event (the connector raycasts independently for capture). We
    // intersect recursively (glTF models nest meshes) and climb to the nearest
    // named, pickable ancestor.
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    function pickAt(clientX: number, clientY: number): string | undefined {
      // Pointer Lock (ADR 0034): the cursor is frozen and the crosshair is screen
      // centre, so pick from NDC (0,0) instead of the stale clientX/Y.
      if (typeof document !== "undefined" && document.pointerLockElement === canvas) {
        ndc.set(0, 0);
      } else {
        const rect = canvas.getBoundingClientRect();
        ndc.set(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        );
      }
      raycaster.setFromCamera(ndc, camera);
      for (const hit of raycaster.intersectObjects(pickTargets, true)) {
        let node: Object3D | null = hit.object;
        while (node) {
          if (node.name && setup.isPickable(node.name)) return node.name;
          node = node.parent;
        }
      }
      return undefined;
    }

    const cap = ctx.capture;
    const client = trackScene(scene, camera, renderer, {
      projectId: ctx.projectId,
      endpoint: ctx.collectorUrl,
      flushIntervalMs: 3000,
      transport: ctx.transport,
      sampling: {
        camera: 10,
        pointerMove: 30,
        // Per-node sampling the scene declares (e.g. the walkable NPC); `capture.nodes` gates it.
        ...(setup.nodeSampling ? { nodes: setup.nodeSampling } : {}),
      },
      // Resolve actor roots by name (scene.getObjectByName); children are walked
      // automatically and emitted with childPath (ADR 0033).
      ...(setup.actors ? { actors: setup.actors } : {}),
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
        keyboard: cap.keyboard,
        nodes: cap.nodes,
      },
      ...(ctx.keyBindings ? { keyBindings: ctx.keyBindings } : {}),
      sceneDescription: `playground (three, ${ctx.cameraMode})`,
      meta: { sceneId: ctx.sceneId },
      cameraType: setup.cameraType ?? "arc-rotate",
      user: { id: "anon-playground-user", traits: { demo: true } },
      debug: true,
    });

    let clickCount = 0;
    canvas.addEventListener("click", (e) => {
      const name = pickAt(e.clientX, e.clientY);
      if (!name) return;
      flashMesh(name);
      clickCount += 1;
      ctx.onBoxPick(name);
      client.track(setup.pickEvent ?? "box_picked", { box: name, totalPicks: clickCount });
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
        setup.disposeScene?.();
        void client.stop("manual");
        renderer.dispose();
      },
    };
  }

  return {
    id: options.id ?? "three",
    label: options.label ?? "three.js",
    // Append the scene-actor (NPC) toggle to the shared set (walkable scene only;
    // inert in the viewer scene where no actors are declared) — ADR 0027.
    captureFeatures: options.captureFeatures ?? DEFAULT_CAPTURE_FEATURES,
    capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
    mount,
  };
}

export const engine: EngineModule = createThreeEngineModule({ build: buildDemoScene });
