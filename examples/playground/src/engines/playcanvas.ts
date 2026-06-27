// PlayCanvas engine module: builds the demo scene with a tiny orbit controller,
// starts the `@uptimizr/playcanvas` connector, and exposes replay + scene-proxy
// glue. No in-scene heatmap (no PlayCanvas heatmap adapter yet).

import * as pc from "playcanvas";

import { createSceneRaycaster, scanSceneProxy, trackScene } from "@uptimizr/playcanvas";

import {
  BOX_COLORS,
  COMMON_CAPTURE_FEATURES,
  registerSectionProxies,
  sectionAt,
  type CaptureFeature,
  type EngineCapabilities,
  type EngineId,
  type EngineInstance,
  type EngineModule,
  type EngineMountContext,
  type SceneSection,
} from "../engine.js";
import { buildWalkableScene } from "./playcanvas-walkable.js";

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

/**
 * What a PlayCanvas scene builder hands back to the shared `mount`: the app +
 * camera, optional name→material map for flashing demo meshes, which mesh names
 * are pickable, the custom pick event, camera type, and any actor/node sampling.
 * Custom scenes (e.g. a real glTF model under `src/scenes/<id>/playcanvas.ts`)
 * provide this; the connector/picking/replay/proxy wiring below is shared.
 */
export interface PlayCanvasSceneSetup {
  readonly app: pc.Application;
  readonly camera: pc.Entity;
  /** name→material for flashing demo meshes (boxes/items). glTF scenes omit it. */
  readonly flashMaterials?: Map<string, pc.StandardMaterial>;
  /** True for mesh names that should flash + emit a pick. */
  isPickable(meshName: string): boolean;
  readonly pickEvent?: string;
  readonly cameraType?: "free" | "arc-rotate";
  readonly nodeSampling?: Record<string, { hz: number; include?: string[] | "*" }>;
  readonly actors?: Record<string, string>;
  /** Scene-specific teardown (walkable). */
  disposeScene?(): void;
  /**
   * Self-declared sub-areas of one large scene (ADR 0040 §5). As the camera enters a
   * section's axis-aligned box the connector calls `client.setScene(section.id)`, so the
   * continuous space is tracked as distinct, semantically-named areas. The first matching
   * section (or `defaultSceneId`) is active on entry; boxes are tested in order.
   */
  readonly sections?: readonly SceneSection[];
  /**
   * Scene id used while the camera is in none of the {@link sections} (and the starting
   * id before the first match). Defaults to `ctx.sceneId`.
   */
  readonly defaultSceneId?: string;
}

/** Builds the PlayCanvas scene for a mount; may load assets asynchronously. */
export type PlayCanvasSceneBuilder = (
  canvas: HTMLCanvasElement,
  ctx: EngineMountContext,
) => PlayCanvasSceneSetup | Promise<PlayCanvasSceneSetup>;

/** Options for {@link createPlayCanvasEngineModule}. Only `build` is required. */
export interface PlayCanvasEngineOptions {
  readonly build: PlayCanvasSceneBuilder;
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
function buildDemoScene(canvas: HTMLCanvasElement, ctx: EngineMountContext): PlayCanvasSceneSetup {
  const isDemoPickable = (name: string): boolean =>
    name.startsWith("box-") || name.startsWith("item-");
  if (ctx.cameraMode === "first-person") {
    const walkable = buildWalkableScene(canvas);
    return {
      app: walkable.app,
      camera: walkable.camera,
      flashMaterials: walkable.materials,
      isPickable: isDemoPickable,
      cameraType: "free",
      nodeSampling: { npc: { hz: 10, include: "*" } },
      actors: { npc: "npc" },
      disposeScene: () => walkable.dispose(),
    };
  }
  const built = buildScene(canvas);
  attachOrbit(canvas, built.camera);
  return {
    app: built.app,
    camera: built.camera,
    flashMaterials: built.boxMaterials,
    isPickable: isDemoPickable,
    cameraType: "arc-rotate",
  };
}

/**
 * Build a PlayCanvas `EngineModule` around a scene builder. The default export
 * wraps {@link buildDemoScene}; custom scenes (e.g. a real glTF model) pass their
 * own `build` and reuse all of the connector/picking/replay/proxy wiring.
 */
export function createPlayCanvasEngineModule(options: PlayCanvasEngineOptions): EngineModule {
  async function mount(ctx: EngineMountContext): Promise<EngineInstance> {
    const canvas = ctx.canvas;
    const setup = await options.build(canvas, ctx);
    const { app, camera } = setup;

    // Flash a mesh by briefly raising its emissive, then restoring it. Demo scenes
    // pass a name→material map; glTF scenes resolve the entity + its mesh materials.
    function flashMesh(name: string): void {
      const flashOne = (mat: pc.StandardMaterial): void => {
        const prev = mat.emissive.clone();
        mat.emissive = new pc.Color(0.5, 0.5, 0.55);
        mat.update();
        setTimeout(() => {
          mat.emissive = prev;
          mat.update();
        }, 220);
      };
      const mapped = setup.flashMaterials?.get(name);
      if (mapped) {
        flashOne(mapped);
        return;
      }
      const entity = app.root.findByName(name);
      if (!(entity instanceof pc.Entity)) return;
      for (const render of entity.findComponents("render") as pc.RenderComponent[]) {
        for (const mi of render.meshInstances) {
          if (mi.material instanceof pc.StandardMaterial) flashOne(mi.material);
        }
      }
    }

    // PlayCanvas has no built-in picking observable, so the demo reuses the
    // connector's `createSceneRaycaster` to detect clicks for the flash + event.
    const probe = createSceneRaycaster(app, camera);
    function pickAt(clientX: number, clientY: number): string | undefined {
      // Pointer Lock (ADR 0034): the cursor is frozen and the crosshair is screen
      // centre, so pick from NDC (0,0) instead of the stale clientX/Y.
      let ndcX: number;
      let ndcY: number;
      if (typeof document !== "undefined" && document.pointerLockElement === canvas) {
        ndcX = 0;
        ndcY = 0;
      } else {
        const rect = canvas.getBoundingClientRect();
        ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
      }
      const name = probe(ndcX, ndcY)?.name;
      return name && setup.isPickable(name) ? name : undefined;
    }

    const cap = ctx.capture;
    const client = trackScene(app, camera, {
      projectId: ctx.projectId,
      endpoint: ctx.collectorUrl,
      flushIntervalMs: 3000,
      transport: ctx.transport,
      ...(ctx.offload ? { offload: ctx.offload } : {}),
      sampling: {
        camera: 10,
        pointerMove: 30,
        // Per-node sampling the scene declares (e.g. the walkable NPC); `capture.nodes` gates it.
        ...(setup.nodeSampling ? { nodes: setup.nodeSampling } : {}),
      },
      // Resolve actor roots by name (findByName); children are walked automatically
      // and emitted with childPath (ADR 0033).
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
      sceneDescription: `playground (playcanvas, ${ctx.cameraMode})`,
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

    // Large-scene section auto-switching (ADR 0040 §5): when the scene declares
    // sub-area boxes, watch the camera each frame (PlayCanvas `update` event) and call
    // `setScene` as it crosses a boundary, so one continuous space is tracked as
    // distinct, named areas. The shell mirrors the active id in the HUD.
    let onSectionUpdate: (() => void) | null = null;
    if (setup.sections && setup.sections.length > 0) {
      const sections = setup.sections;
      const fallbackSceneId = setup.defaultSceneId ?? ctx.sceneId;
      const sectionFor = (): string => {
        const p = camera.getPosition();
        return sectionAt(sections, fallbackSceneId, p.x, p.y, p.z);
      };
      let activeSection = sectionFor();
      if (activeSection !== ctx.sceneId) {
        client.setScene(activeSection);
        ctx.onSceneChange?.(activeSection);
      }
      onSectionUpdate = (): void => {
        const next = sectionFor();
        if (next !== activeSection) {
          activeSection = next;
          client.setScene(next);
          ctx.onSceneChange?.(next);
        }
      };
      app.on("update", onSectionUpdate);
    }

    const { createPlayCanvasReplayDriver } = await import("@uptimizr/replay/playcanvas");

    // Shared PUT for a scanned proxy → /scenes/:id/representation (single-scene and
    // per-section registration for large scenes).
    const putProxy = async (
      proxySceneId: string,
      proxy: ReturnType<typeof scanSceneProxy>,
    ): Promise<void> => {
      const res = await fetch(
        `${ctx.collectorUrl.replace(/\/$/, "")}/api/v1/scenes/${encodeURIComponent(proxySceneId)}/representation`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", "x-api-key": ctx.apiKey },
          body: JSON.stringify({ proxy, label: proxySceneId }),
        },
      );
      if (!res.ok) throw new Error(`Proxy registration failed (${res.status}).`);
    };

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
        await putProxy(sceneId, proxy);
        return proxy.meshCount;
      },
      ...(setup.sections && setup.sections.length > 0
        ? {
            registerSceneProxies: () =>
              registerSectionProxies({
                scan: (options) => scanSceneProxy(app, options),
                put: putProxy,
                sections: setup.sections ?? [],
                defaultSceneId: setup.defaultSceneId ?? ctx.sceneId,
              }),
          }
        : {}),
      dispose() {
        if (onSectionUpdate) app.off("update", onSectionUpdate);
        setup.disposeScene?.();
        void client.stop("manual");
        app.destroy();
      },
    };
  }

  return {
    id: options.id ?? "playcanvas",
    label: options.label ?? "PlayCanvas",
    // Append the scene-actor (NPC) toggle to the shared set (walkable scene only;
    // inert in the viewer scene where no actors are declared) — ADR 0027.
    captureFeatures: options.captureFeatures ?? DEFAULT_CAPTURE_FEATURES,
    capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
    mount,
  };
}

export const engine: EngineModule = createPlayCanvasEngineModule({ build: buildDemoScene });
