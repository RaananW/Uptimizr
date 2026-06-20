/**
 * Babylon **Lite** adapter for `@uptimizr/heatmap` — the Tier 0 "dev-integrated
 * overlay" (ADR 0010). Like the `@babylonjs/core` driver it draws the heatmap
 * voxels **into the host application's own scene** as a single thin-instanced
 * box, so a developer can overlay analytics heat on their live scene.
 *
 * Babylon Lite is a functional / data-oriented, **WebGPU** engine, so this driver
 * uses free functions (`createBox`, `setThinInstances`, …) operating on the
 * host's scene context instead of the class-based `Mesh`/`StandardMaterial` of
 * `@babylonjs/core`. `@babylonjs/lite` is an **optional peer dependency** the
 * host provides. The voxel boxes are unlit (emissive) so the heat colors read
 * consistently regardless of the host scene's lighting.
 */
import {
  addToScene,
  createBox,
  createStandardMaterial,
  flushThinInstances,
  onBeforeRender,
  removeFromScene,
  setThinInstanceColors,
  setThinInstanceCount,
  setThinInstances,
} from "@babylonjs/lite";
import type { Camera, Mat4, Mesh, SceneContext, StandardMaterialProps } from "@babylonjs/lite";

import {
  fetchGazeHeatmap,
  fetchWorldHeatmap,
  type FetchGazeHeatmapOptions,
  type FetchWorldHeatmapOptions,
} from "../fetchHeatmap.js";
import { GazeOverlay, type GazeStyle } from "../gaze.js";
import { HeatmapOverlay } from "../overlay.js";
import type { HeatmapDriver, HeatmapInstance, HeatmapStyle } from "../types.js";

/** Read a Mat4 index, coercing the (index-signature) read to a concrete number. */
function mat4At(mat: Mat4, i: number): number {
  return (mat as unknown as Record<number, number>)[i] ?? 0;
}

/** Per-frame hook signature — Lite's `onBeforeRender`, narrowed and injectable for tests. */
export type LiteFrameHook = (scene: SceneContext, cb: (deltaMs: number) => void) => void;

/** Options for {@link createBabylonLiteHeatmapDriver}. */
export interface BabylonLiteHeatmapDriverOptions {
  /** The host scene to draw the heatmap into. */
  scene: SceneContext;
  /** Base name for the created mesh (default `"uptimizr-heatmap"`). */
  name?: string;
  /**
   * Optional per-frame world-translation offset applied to every instance. Lite's
   * thin-instance matrices are **world-space** (they don't compound with the
   * mesh's own/parent transform, unlike `@babylonjs/core`), so to make a batch
   * follow a moving node the driver adds this offset to each instance's
   * translation each frame. Used by {@link showGazeDome}'s `followCamera` mode.
   */
  follow?: () => readonly [number, number, number];
  /**
   * Per-frame hook used to apply {@link follow}. Defaults to Lite's
   * `onBeforeRender`; injectable so tests can drive frames deterministically.
   */
  frameHook?: LiteFrameHook;
}

/**
 * Create a {@link HeatmapDriver} that renders heat voxels as one thin-instanced
 * unit box inside `options.scene`. The box is built at unit size; each instance's
 * world size comes from its {@link HeatmapInstance.scale} via the instance matrix.
 */
export function createBabylonLiteHeatmapDriver(
  options: BabylonLiteHeatmapDriverOptions,
): HeatmapDriver {
  const scene = options.scene;
  // The owning engine is reachable via `scene.surface.engine` (Lite docs).
  const engine = scene.surface.engine;
  const name = options.name ?? "uptimizr-heatmap";

  const box: Mesh = createBox(engine, 1);
  box.name = name;
  // The overlay must never intercept the host's GPU picks.
  box.pickable = false;

  const material: StandardMaterialProps = createStandardMaterial();
  material.disableLighting = true;
  material.emissiveColor = [1, 1, 1];
  material.diffuseColor = [0, 0, 0];
  material.specularColor = [0, 0, 0];
  box.material = material;
  addToScene(scene, box);

  let built = false;
  let disposed = false;
  // For `follow` mode: the origin-relative matrices (translations as built) so
  // each frame can recompute `live = base + cameraOffset` without re-binning.
  let baseMatrices: Float32Array | null = null;
  let liveMatrices: Float32Array | null = null;
  let count = 0;

  /** Rewrite the live buffer's translations as base + the current follow offset. */
  const applyFollow = (): void => {
    if (!options.follow || !baseMatrices || !liveMatrices) return;
    const [ox, oy, oz] = options.follow();
    const base = baseMatrices;
    const live = liveMatrices;
    for (let i = 0; i < count; i++) {
      const o = i * 16;
      live[o + 12] = base[o + 12]! + ox;
      live[o + 13] = base[o + 13]! + oy;
      live[o + 14] = base[o + 14]! + oz;
    }
    setThinInstances(box, live, count);
    flushThinInstances(box);
  };

  // Register the follow hook once. Lite's `onBeforeRender` returns void (no
  // unsubscribe), so the callback is guarded by `disposed` and no-ops after
  // dispose — the same pattern the Lite collector uses for its frame hook.
  if (options.follow) {
    const frameHook = options.frameHook ?? onBeforeRender;
    frameHook(scene, () => {
      if (disposed || !built) return;
      applyFollow();
    });
  }

  const render = (instances: readonly HeatmapInstance[]): void => {
    if (instances.length === 0) {
      clear();
      return;
    }

    const n = instances.length;
    const matrices = new Float32Array(n * 16);
    const colors = new Float32Array(n * 4);
    let minAlpha = 1;

    for (let i = 0; i < n; i++) {
      const inst = instances[i]!;
      const s = inst.scale;
      const [x, y, z] = inst.position;
      // Column-major scale + translation (Lite stores matrices column-major;
      // a diagonal-plus-translation matrix puts scale at 0/5/10 and translation
      // at 12/13/14, identical to Babylon's row-major layout for this case).
      const o = i * 16;
      matrices[o] = s;
      matrices[o + 5] = s;
      matrices[o + 10] = s;
      matrices[o + 12] = x;
      matrices[o + 13] = y;
      matrices[o + 14] = z;
      matrices[o + 15] = 1;

      const [r, g, b, a] = inst.color;
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
      if (a < minAlpha) minAlpha = a;
    }

    // The core applies one constant opacity, so a single material-level alpha is
    // enough; alpha < 1 makes Lite blend the unlit voxels.
    material.alpha = minAlpha < 1 ? minAlpha : 1;

    count = n;
    liveMatrices = matrices;
    // In follow mode the built translations are origin-relative (the dome is
    // centered on [0,0,0]); keep a copy and apply the current offset so the very
    // first frame is already correctly positioned, before the hook fires.
    if (options.follow) {
      baseMatrices = matrices.slice();
      const [ox, oy, oz] = options.follow();
      for (let i = 0; i < n; i++) {
        const o = i * 16;
        matrices[o + 12] = (matrices[o + 12] ?? 0) + ox;
        matrices[o + 13] = (matrices[o + 13] ?? 0) + oy;
        matrices[o + 14] = (matrices[o + 14] ?? 0) + oz;
      }
    }

    setThinInstances(box, matrices, n);
    setThinInstanceColors(box, colors);
    flushThinInstances(box);
    box.visible = true;
    built = true;
  };

  const clear = (): void => {
    setThinInstanceCount(box, 0);
    flushThinInstances(box);
    box.visible = false;
    built = false;
    baseMatrices = null;
    liveMatrices = null;
    count = 0;
  };

  const setVisible = (visible: boolean): void => {
    box.visible = visible && built;
  };

  const dispose = (): void => {
    disposed = true;
    removeFromScene(scene, box);
  };

  return { render, clear, setVisible, dispose };
}

/** Options for {@link showWorldHeatmap}, a one-call fetch-and-render helper. */
export interface ShowWorldHeatmapOptions extends FetchWorldHeatmapOptions {
  /** Scene to draw the heatmap into. */
  scene: SceneContext;
  /** Base name for the created mesh. */
  name?: string;
  /** Styling for the voxel instances (color ramp, scaling, opacity, cap). */
  style?: HeatmapStyle;
}

/**
 * Fetch a world heatmap from the collector and render it into `options.scene` in
 * one call. Returns the {@link HeatmapOverlay} so the host can re-render, hide, or
 * dispose it. Mirrors the `@babylonjs/core` driver's ergonomics.
 */
export async function showWorldHeatmap(options: ShowWorldHeatmapOptions): Promise<HeatmapOverlay> {
  const data = await fetchWorldHeatmap(options);
  const driver = createBabylonLiteHeatmapDriver({ scene: options.scene, name: options.name });
  const overlay = new HeatmapOverlay(driver, options.style);
  overlay.render(data);
  return overlay;
}

/** Options for {@link showGazeDome}, a one-call fetch-and-render gaze helper. */
export interface ShowGazeDomeOptions extends FetchGazeHeatmapOptions {
  /** Scene to draw the gaze dome into. */
  scene: SceneContext;
  /** Base name for the created mesh (default `"uptimizr-gaze"`). */
  name?: string;
  /** Styling for the dome markers (radius, color ramp, scaling, opacity, cap). */
  style?: GazeStyle;
  /**
   * Keep the dome centered on this camera every frame, so the developer stands
   * inside the gaze distribution. When set, {@link GazeStyle.center} is ignored
   * (the dome is built around the origin and the whole batch follows the camera's
   * world position each frame). Mirrors the `@babylonjs/core` driver.
   */
  followCamera?: Camera;
  /**
   * Per-frame hook used to drive {@link followCamera}. Defaults to Lite's
   * `onBeforeRender`; injectable so tests can step frames deterministically.
   */
  frameHook?: LiteFrameHook;
}

/**
 * Fetch a gaze (camera view-direction) heatmap from the collector and render it
 * as a dome of markers into `options.scene` in one call. Returns the
 * {@link GazeOverlay} so the host can re-render, hide, or dispose it.
 *
 * Pass {@link ShowGazeDomeOptions.followCamera} to keep the dome centered on a
 * live camera, so the developer stands inside the gaze distribution; otherwise it
 * sits at {@link GazeStyle.center} (default origin). Because Lite's thin-instance
 * matrices are world-space (no parent compounding), follow mode re-offsets the
 * instance translations each frame rather than parenting a node. Mirrors the
 * `@babylonjs/core` driver's ergonomics.
 */
export async function showGazeDome(options: ShowGazeDomeOptions): Promise<GazeOverlay> {
  const data = await fetchGazeHeatmap(options);
  const scene = options.scene;
  const name = options.name ?? "uptimizr-gaze";

  let style: GazeStyle = options.style ?? {};
  const driverOptions: BabylonLiteHeatmapDriverOptions = { scene, name };

  const camera = options.followCamera;
  if (camera) {
    // Build the dome around the origin; the per-frame follow offset supplies the
    // world position so the camera sits at the dome's center.
    style = { ...style, center: [0, 0, 0] };
    driverOptions.follow = () => {
      const wm = camera.worldMatrix;
      return [mat4At(wm, 12), mat4At(wm, 13), mat4At(wm, 14)] as const;
    };
    if (options.frameHook) driverOptions.frameHook = options.frameHook;
  }

  const driver = createBabylonLiteHeatmapDriver(driverOptions);
  const overlay = new GazeOverlay(driver, style);
  overlay.render(data);
  return overlay;
}
