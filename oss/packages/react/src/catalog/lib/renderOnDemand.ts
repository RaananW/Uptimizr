/**
 * Render a Babylon panel scene only when something can have changed it.
 *
 * The 3D panels used to call `scene.render()` on every animation frame, so an
 * overview with five or six of them redrew every one 60 times a second while
 * nothing moved. That costs CPU and battery on any machine, and on a renderer
 * without a GPU (SwiftShader in CI, some VMs and remote desktops) it saturated
 * the CPU and stalled every other page.
 *
 * A panel scene changes when the camera moves, when the viewer points, scrolls
 * or types at it, when it is resized, when meshes or materials come and go, and
 * when the panel repaints its data (it calls {@link RenderOnDemand.invalidate}).
 * Each of those keeps the scene rendering for {@link ACTIVE_FRAMES} frames, long
 * enough for camera inertia and a late shader compile. The scene also renders
 * while it is not ready yet, and once every {@link IDLE_RENDER_MS} whatever
 * happens, so a change nothing reported still shows within half a second.
 *
 * Babylon types are read structurally, so this file adds no Babylon import.
 */

/** Frames to keep rendering after a change (~0.5 s at 60 fps). */
export const ACTIVE_FRAMES = 30;
/** The longest an idle scene goes without a frame. */
export const IDLE_RENDER_MS = 500;

interface ObservableLike {
  add(callback: () => void): unknown;
  remove(observer: unknown): unknown;
}

/** The slice of a Babylon `Engine` this reads. */
export interface RenderEngineLike {
  runRenderLoop(callback: () => void): void;
  stopRenderLoop(callback?: () => void): void;
  onResizeObservable?: ObservableLike;
}

/** The slice of a Babylon `Scene` this reads. */
export interface RenderSceneLike {
  render(): void;
  isReady(): boolean;
  activeCamera?: { onViewMatrixChangedObservable?: ObservableLike } | null;
  onPointerObservable?: ObservableLike;
  onNewMeshAddedObservable?: ObservableLike;
  onMeshRemovedObservable?: ObservableLike;
  onNewMaterialAddedObservable?: ObservableLike;
}

/** See {@link renderOnDemand}. */
export interface RenderOnDemand {
  /** Something changed that the scene can't see (a data repaint): render it. */
  invalidate(): void;
  /** Stop the render loop and detach every listener. */
  dispose(): void;
}

/**
 * Start `scene`'s render loop on `engine`, rendering only when needed (see the
 * file comment). Replaces `engine.runRenderLoop(() => scene.render())`. Pass the
 * panel's element as `inputTarget` so input on its HTML controls counts too.
 */
export function renderOnDemand(
  engine: RenderEngineLike,
  scene: RenderSceneLike,
  inputTarget?: Pick<HTMLElement, "addEventListener" | "removeEventListener">,
  now: () => number = () => performance.now(),
): RenderOnDemand {
  let framesLeft = ACTIVE_FRAMES; // the first frames: the scene is new
  let lastRender = -Infinity;
  const invalidate = (): void => {
    framesLeft = ACTIVE_FRAMES;
  };

  const detach: Array<() => void> = [];
  const watch = (observable: ObservableLike | undefined): void => {
    if (!observable) return;
    const observer = observable.add(invalidate);
    detach.push(() => observable.remove(observer));
  };
  watch(scene.activeCamera?.onViewMatrixChangedObservable);
  watch(scene.onPointerObservable);
  watch(scene.onNewMeshAddedObservable);
  watch(scene.onMeshRemovedObservable);
  watch(scene.onNewMaterialAddedObservable);
  watch(engine.onResizeObservable);
  if (inputTarget) {
    // The panel's own element, not just the canvas: its HTML zoom buttons move
    // the camera too, and keyboard camera input is read inside `scene.render()`,
    // so the input itself has to start the frames that apply it.
    for (const type of ["pointerdown", "pointermove", "wheel", "keydown"] as const) {
      inputTarget.addEventListener(type, invalidate, { capture: true, passive: true });
      detach.push(() => inputTarget.removeEventListener(type, invalidate, { capture: true }));
    }
  }

  const frame = (): void => {
    const t = now();
    if (framesLeft > 0 || !scene.isReady() || t - lastRender >= IDLE_RENDER_MS) {
      if (framesLeft > 0) framesLeft -= 1;
      lastRender = t;
      scene.render();
    }
  };
  engine.runRenderLoop(frame);

  return {
    invalidate,
    dispose() {
      engine.stopRenderLoop(frame);
      for (const off of detach.splice(0)) off();
    },
  };
}
