import {
  Engine,
  Scene,
  ArcRotateCamera,
  HemisphericLight,
  Vector3,
  Color4,
  Color3,
  PointerEventTypes,
  RegisterStandardEngineExtensions,
  RegisterStandardMaterial,
  RegisterLinesMesh,
  RegisterThinInstanceMesh,
} from "@babylonjs/core/pure";

// The pure barrel ships zero side effects, so the runtime registrations the demo
// relies on must be activated explicitly: engine extensions (alpha blending,
// uniform buffers, render targets), the default StandardMaterial, line meshes,
// and the Mesh thin-instance buffers used by every tab. All are safe to call once.
RegisterStandardEngineExtensions();
RegisterStandardMaterial();
RegisterLinesMesh();
RegisterThinInstanceMesh();

import type { DemoContext, DemoTab } from "./types.js";
import { createDomeTab } from "./dome.js";
import { createClickRaysTab } from "./clickRays.js";
import { createFlowTab } from "./flow.js";
import { createWorldTab } from "./world.js";

export interface DemoElements {
  canvas: HTMLCanvasElement;
  tabButtons: HTMLButtonElement[];
  badge: HTMLElement;
  hint: HTMLElement;
}

export interface DemoHandle {
  dispose(): void;
}

/**
 * Boot the tabbed hero demo. Each tab reproduces a real dashboard 3D panel
 * (View dome, Click rays, Flow Sankey, World heatmap) with emulated data, sharing
 * one Babylon engine/scene/camera. Background and colors match the dashboard.
 */
export function initSceneDemo(elements: DemoElements): DemoHandle {
  const { canvas, tabButtons, badge, hint } = elements;

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false }, true);
  // Babylon sets the canvas tabindex to 1 during engine init; override to 0 so the
  // canvas stays keyboard-focusable for camera controls without tripping the
  // Lighthouse "tabindex > 0" accessibility audit.
  canvas.tabIndex = 0;
  const scene = new Scene(engine);
  // Dark navy, opaque — the same backdrop the dashboard panels use.
  scene.clearColor = new Color4(0.04, 0.05, 0.07, 1);

  const camera = new ArcRotateCamera("demo-cam", Math.PI / 4, Math.PI / 3, 4, Vector3.Zero(), scene);
  camera.attachControl(canvas, true);
  // Drop mouse-wheel zoom so scrolling the page past the demo never zooms the scene.
  camera.inputs.removeByType("ArcRotateCameraMouseWheelInput");
  camera.pinchDeltaPercentage = 0.01;
  camera.lowerBetaLimit = 0.15;
  camera.upperBetaLimit = Math.PI - 0.15;

  const light = new HemisphericLight("demo-light", new Vector3(0.3, 1, 0.2), scene);
  light.intensity = 0.9;
  light.groundColor = new Color3(0.1, 0.12, 0.16);

  const ctx: DemoContext = { scene, camera, canvas, reduced };

  const tabs: DemoTab[] = [createDomeTab(), createClickRaysTab(), createFlowTab(), createWorldTab()];
  for (const tab of tabs) tab.build(ctx);

  let active = tabs[0]!;

  const applyMeta = (tab: DemoTab): void => {
    badge.textContent = tab.badge;
    hint.textContent = tab.hint;
  };

  const setActiveByIndex = (index: number): void => {
    const next = tabs[index];
    if (!next || next === active) {
      focusTab(index);
      return;
    }
    active.exit(ctx);
    active = next;
    active.enter(ctx);
    applyMeta(active);
    tabButtons.forEach((btn, i) => {
      const selected = i === index;
      btn.setAttribute("aria-selected", String(selected));
      btn.tabIndex = selected ? 0 : -1;
    });
    focusTab(index);
  };

  const focusTab = (index: number): void => {
    tabButtons[index]?.focus();
  };

  tabButtons.forEach((btn, i) => {
    btn.addEventListener("click", () => setActiveByIndex(i));
    btn.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        setActiveByIndex((i + 1) % tabs.length);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveByIndex((i - 1 + tabs.length) % tabs.length);
      }
    });
  });

  scene.onPointerObservable.add((info) => {
    if (info.type === PointerEventTypes.POINTERMOVE) active.pointerMove?.(ctx, info);
    else if (info.type === PointerEventTypes.POINTERDOWN) active.pointerDown?.(ctx, info);
  });

  // Initialize first tab.
  active.enter(ctx);
  applyMeta(active);
  tabButtons.forEach((btn, i) => {
    const selected = i === 0;
    btn.setAttribute("aria-selected", String(selected));
    btn.tabIndex = selected ? 0 : -1;
  });

  engine.runRenderLoop(() => {
    active.update?.(ctx);
    scene.render();
  });

  const onResize = (): void => engine.resize();
  window.addEventListener("resize", onResize);

  return {
    dispose() {
      window.removeEventListener("resize", onResize);
      for (const tab of tabs) tab.dispose?.();
      engine.stopRenderLoop();
      scene.dispose();
      engine.dispose();
    },
  };
}
