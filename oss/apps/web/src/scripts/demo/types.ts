import type { Scene, ArcRotateCamera, PointerInfo } from "@babylonjs/core/pure";

/** Everything a demo tab needs to draw into the shared Babylon scene. */
export interface DemoContext {
  scene: Scene;
  camera: ArcRotateCamera;
  canvas: HTMLCanvasElement;
  /** True when the visitor prefers reduced motion — tabs should skip auto-rotation. */
  reduced: boolean;
}

/**
 * One switchable visualization. Each tab mirrors a real dashboard 3D panel
 * (`CameraDome3D`, `ClickRays3D`, `FlowSankey3D`, `WorldHeatmap3D`) using
 * emulated-but-consistent data, so the hero shows the genuine dashboard view.
 */
export interface DemoTab {
  readonly id: string;
  readonly label: string;
  /** Short caption shown under the stage when this tab is active. */
  readonly badge: string;
  /** One-sentence explanation of what the view shows. */
  readonly hint: string;
  /** Build meshes once (kept disabled until entered). */
  build(ctx: DemoContext): void;
  /** Show this tab's meshes and frame the camera. */
  enter(ctx: DemoContext): void;
  /** Hide this tab's meshes. */
  exit(ctx: DemoContext): void;
  /** Per-frame hook (e.g. gentle auto-rotation). */
  update?(ctx: DemoContext): void;
  /** Forwarded pointer move while active. */
  pointerMove?(ctx: DemoContext, info: PointerInfo): void;
  /** Forwarded pointer down while active. */
  pointerDown?(ctx: DemoContext, info: PointerInfo): void;
  /** Release GPU resources. */
  dispose?(): void;
}
