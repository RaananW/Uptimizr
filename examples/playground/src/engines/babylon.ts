// Babylon.js engine module: builds the demo scene, starts the `@uptimizr/babylon`
// connector, and exposes replay, 3D heatmap overlay, and scene-proxy glue. The
// shared shell (src/shell.ts) owns all of the surrounding UI.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { Scene as BabylonScene } from "@babylonjs/core/scene.js";

import { scanSceneProxy, trackScene } from "@uptimizr/babylon";
import { showWorldHeatmap } from "@uptimizr/heatmap/babylon";

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

/**
 * What a Babylon scene builder hands back to the shared `mount`: the built scene
 * + camera, which meshes are pickable/flashable, the developer-defined custom
 * event a pick emits, plus any actor/node sampling the scene needs (ADR 0027/0033).
 * This is the only engine-specific surface a custom scene (e.g. a real glTF model
 * under `src/scenes/<id>/babylon.ts`) has to provide — the connector wiring,
 * picking, replay, heatmap and proxy glue below are shared.
 */
export interface BabylonSceneSetup {
  readonly scene: BabylonScene;
  readonly camera: Camera;
  /** True for meshes that should flash + emit a pick (default: box-/item- demo meshes). */
  isPickable(meshName: string): boolean;
  /** The custom event name emitted on a pick (default `box_picked`). */
  readonly pickEvent?: string;
  /** Extra per-node sampling merged into `sampling` (e.g. the walkable NPC). */
  readonly nodeSampling?: Record<string, { hz: number; include?: string[] | "*" }>;
  /** Actor name→node bindings (ADR 0033) for self-moving actors. */
  readonly actors?: Record<string, string>;
}

/** Builds the Babylon scene for a mount; may load assets asynchronously. */
export type BabylonSceneBuilder = (
  engine: Engine,
  ctx: EngineMountContext,
) => BabylonSceneSetup | Promise<BabylonSceneSetup>;

/** Options for {@link createBabylonEngineModule}. Only `build` is required. */
export interface BabylonEngineOptions {
  readonly build: BabylonSceneBuilder;
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
  heatmap: true,
  sceneProxy: true,
};

/** The built-in demo scene builder: orbit boxes (viewer) or the walkable room. */
function buildDemoScene(engine: Engine, ctx: EngineMountContext): BabylonSceneSetup {
  // The walkable scene ships an ambient NPC (a `TransformNode` named "npc") whose
  // body + head meshes are parented to it and patrol on their own — exactly the
  // "self-moving actor" replay can't capture from visitor input (ADR 0027). Track
  // the `npc` root as a single subtree actor (ADR 0033 `include: "*"`): the
  // connector walks its children and emits each part with a `childPath`
  // ("npc-body", "npc-head"), so the whole figure is recorded from one declaration.
  // The orbital viewer scene has no such actor.
  if (ctx.cameraMode === "first-person") {
    const { scene, camera } = buildWalkableScene(engine, ctx.canvas);
    return {
      scene,
      camera,
      isPickable: (name) => name.startsWith("box-") || name.startsWith("item-"),
      nodeSampling: { npc: { hz: 10, include: "*" } },
      actors: { npc: "npc" },
    };
  }
  const { scene, camera } = buildScene(engine);
  return {
    scene,
    camera,
    isPickable: (name) => name.startsWith("box-") || name.startsWith("item-"),
  };
}

/**
 * Build a Babylon `EngineModule` around a scene builder. The default export wraps
 * {@link buildDemoScene}; custom scenes (e.g. a real glTF model) pass their own
 * `build` and reuse all of the connector/picking/replay/heatmap/proxy wiring.
 */
export function createBabylonEngineModule(options: BabylonEngineOptions): EngineModule {
  async function mount(ctx: EngineMountContext): Promise<EngineInstance> {
    const engine = new Engine(ctx.canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const setup = await options.build(engine, ctx);
    const { scene, camera } = setup;
    engine.runRenderLoop(() => scene.render());
    const onResize = (): void => engine.resize();
    window.addEventListener("resize", onResize);

    const sceneId = ctx.sceneId;
    const cap = ctx.capture;
    const pickEvent = setup.pickEvent ?? "box_picked";
    const client = trackScene(scene, {
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
      // Resolve actor roots by name (getTransformNodeByName); children are walked
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

    // Flash a mesh by briefly raising its emissive, then restoring the original.
    // Works for both `StandardMaterial` (demo boxes) and `PBRMaterial` (glTF models).
    function flashMesh(name: string): void {
      const mat = scene.getMeshByName(name)?.material as { emissiveColor?: Color3 } | null | undefined;
      if (!mat || !(mat.emissiveColor instanceof Color3)) return;
      const previous = mat.emissiveColor.clone();
      mat.emissiveColor = new Color3(0.5, 0.5, 0.55);
      setTimeout(() => {
        mat.emissiveColor = previous;
      }, 220);
    }

    // Live click feedback + a developer-defined `custom` event per pick.
    let clickCount = 0;
    scene.onPointerObservable.add((info) => {
      const mesh = info.pickInfo?.pickedMesh;
      if (info.type === PointerEventTypes.POINTERPICK && mesh && setup.isPickable(mesh.name)) {
        flashMesh(mesh.name);
        clickCount += 1;
        ctx.onBoxPick(mesh.name);
        client.track(pickEvent, { box: mesh.name, totalPicks: clickCount });
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

  return {
    id: options.id ?? "babylon",
    label: options.label ?? "Babylon.js",
    captureFeatures: options.captureFeatures ?? CAPTURE_FEATURES,
    capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
    mount,
  };
}

export const engine: EngineModule = createBabylonEngineModule({ build: buildDemoScene });
