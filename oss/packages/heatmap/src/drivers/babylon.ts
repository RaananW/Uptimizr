/**
 * Babylon adapter for `@uptimizr/heatmap` — the Tier 0 "dev-integrated overlay"
 * (ADR 0010). Unlike the dashboard viewer (which owns its own engine and scene),
 * this driver draws the heatmap voxels **into the host application's own scene**
 * as a single thin-instanced box, so a developer can overlay analytics heat on
 * the live scene they already render.
 *
 * `@babylonjs/core` is a peer dependency the host provides. The voxel boxes are
 * unlit (emissive) so the heat colors read consistently regardless of the host
 * scene's lighting.
 */
import type { Camera, Scene } from "@babylonjs/core";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { Material } from "@babylonjs/core/Materials/material.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
// Side-effect: augments Mesh.prototype with the thinInstance* methods used below.
import "@babylonjs/core/Meshes/thinInstanceMesh.js";

import {
  fetchGazeHeatmap,
  fetchWorldHeatmap,
  type FetchGazeHeatmapOptions,
  type FetchWorldHeatmapOptions,
} from "../fetchHeatmap.js";
import { GazeOverlay, type GazeData, type GazeStyle } from "../gaze.js";
import { buildGazeEquirect, type GazeEquirectOptions } from "../gazeSkydome.js";
import { HeatmapOverlay } from "../overlay.js";
import type { HeatmapDriver, HeatmapInstance, HeatmapStyle } from "../types.js";

/** Options for {@link createBabylonHeatmapDriver}. */
export interface BabylonHeatmapDriverOptions {
  /** The host scene to draw the heatmap into. */
  scene: Scene;
  /** Base name for the created mesh/material (default `"uptimizr-heatmap"`). */
  name?: string;
  /** Rendering group for the overlay mesh (default `0`). Raise it to draw on top. */
  renderingGroupId?: number;
  /**
   * Optional parent for the instanced mesh. Instances are then drawn in the
   * parent's local space, so moving the parent moves the whole batch — used by
   * {@link showGazeDome} to make a gaze dome follow a camera.
   */
  parent?: TransformNode;
}

/**
 * Create a {@link HeatmapDriver} that renders heat voxels as one thin-instanced
 * unit box inside `options.scene`. The box is built at unit size; each instance's
 * world size comes from its {@link HeatmapInstance.scale} via the instance matrix.
 */
export function createBabylonHeatmapDriver(options: BabylonHeatmapDriverOptions): HeatmapDriver {
  const name = options.name ?? "uptimizr-heatmap";
  const scene = options.scene;

  const box: Mesh = MeshBuilder.CreateBox(name, { size: 1 }, scene);
  box.isPickable = false;
  box.renderingGroupId = options.renderingGroupId ?? 0;
  box.doNotSyncBoundingInfo = true;
  if (options.parent) box.parent = options.parent;

  const material = new StandardMaterial(`${name}-mat`, scene);
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.backFaceCulling = true;
  box.material = material;

  let built = false;

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
      const m = Matrix.Scaling(s, s, s).multiply(Matrix.Translation(x, y, z));
      m.copyToArray(matrices, i * 16);

      const [r, g, b, a] = inst.color;
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
      if (a < minAlpha) minAlpha = a;
    }

    // Per-instance colors all carry the same alpha (the core applies a constant
    // opacity), so a single material-level alpha + blend pass is enough.
    if (minAlpha < 1) {
      material.alpha = minAlpha;
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    } else {
      material.alpha = 1;
      material.transparencyMode = Material.MATERIAL_OPAQUE;
    }

    box.thinInstanceSetBuffer("matrix", matrices, 16, true);
    box.thinInstanceSetBuffer("color", colors, 4, true);
    box.setEnabled(true);
    built = true;
  };

  const clear = (): void => {
    if (!built) {
      box.setEnabled(false);
      return;
    }
    box.thinInstanceSetBuffer("matrix", new Float32Array(0), 16, true);
    box.thinInstanceSetBuffer("color", new Float32Array(0), 4, true);
    box.setEnabled(false);
    built = false;
  };

  const setVisible = (visible: boolean): void => {
    box.setEnabled(visible && built);
  };

  const dispose = (): void => {
    material.dispose();
    box.dispose();
  };

  return { render, clear, setVisible, dispose };
}

/** Options for {@link showWorldHeatmap}, a one-call fetch-and-render helper. */
export interface ShowWorldHeatmapOptions extends FetchWorldHeatmapOptions {
  /** Scene to draw the heatmap into. */
  scene: Scene;
  /** Base name for the created mesh/material. */
  name?: string;
  /** Rendering group for the overlay mesh. */
  renderingGroupId?: number;
  /** Styling for the voxel instances (color ramp, scaling, opacity, cap). */
  style?: HeatmapStyle;
}

/**
 * Fetch a world heatmap from the collector and render it into `options.scene` in
 * one call. Returns the {@link HeatmapOverlay} so the host can re-render, hide, or
 * dispose it. Mirrors `@uptimizr/replay`'s `replayInScene` ergonomics.
 */
export async function showWorldHeatmap(options: ShowWorldHeatmapOptions): Promise<HeatmapOverlay> {
  const data = await fetchWorldHeatmap(options);
  const driver = createBabylonHeatmapDriver({
    scene: options.scene,
    name: options.name,
    renderingGroupId: options.renderingGroupId,
  });
  const overlay = new HeatmapOverlay(driver, options.style);
  overlay.render(data);
  return overlay;
}

/** Options for {@link showGazeDome}, a one-call fetch-and-render gaze helper. */
export interface ShowGazeDomeOptions extends FetchGazeHeatmapOptions {
  /** Scene to draw the gaze dome into. */
  scene: Scene;
  /** Base name for the created mesh/material (default `"uptimizr-gaze"`). */
  name?: string;
  /** Rendering group for the overlay mesh (default `0`). Raise it to draw on top. */
  renderingGroupId?: number;
  /** Styling for the dome markers (radius, color ramp, scaling, opacity, cap). */
  style?: GazeStyle;
  /**
   * Keep the dome centered on this camera every frame, so the developer stands
   * inside the gaze distribution. When set, {@link GazeStyle.center} is ignored
   * (the dome is built around the origin and the whole batch follows the camera).
   */
  followCamera?: Camera;
}

/**
 * Fetch a gaze (camera view-direction) heatmap from the collector and render it
 * as a dome of markers into `options.scene` in one call. Returns the
 * {@link GazeOverlay} so the host can re-render, hide, or dispose it.
 *
 * Pass {@link ShowGazeDomeOptions.followCamera} to keep the dome centered on a
 * live camera; otherwise it sits at {@link GazeStyle.center} (default origin).
 * Mirrors {@link showWorldHeatmap}'s ergonomics.
 */
export async function showGazeDome(options: ShowGazeDomeOptions): Promise<GazeOverlay> {
  const data = await fetchGazeHeatmap(options);
  const scene = options.scene;
  const name = options.name ?? "uptimizr-gaze";

  let style: GazeStyle = options.style ?? {};
  let parent: TransformNode | undefined;
  let teardown: (() => void) | undefined;

  const camera = options.followCamera;
  if (camera) {
    const follower = new TransformNode(`${name}-follow`, scene);
    follower.position.copyFrom(camera.globalPosition);
    const observer = scene.onBeforeRenderObservable.add(() => {
      follower.position.copyFrom(camera.globalPosition);
    });
    parent = follower;
    // Build the dome around the origin; the follower supplies the world offset.
    style = { ...style, center: [0, 0, 0] };
    teardown = () => {
      scene.onBeforeRenderObservable.remove(observer);
      // `true` = don't recurse: the driver owns and disposes the instanced mesh.
      follower.dispose(true);
    };
  }

  const driver = createBabylonHeatmapDriver({
    scene,
    name,
    renderingGroupId: options.renderingGroupId,
    parent,
  });
  const overlay = new GazeOverlay(driver, style, teardown);
  overlay.render(data);
  return overlay;
}

/** Lifecycle handle returned by {@link showGazeSkydome}. */
export interface GazeSkydomeHandle {
  /** Recompute the equirectangular texture from `data` and re-upload it. */
  render(data: GazeData): void;
  /** Show or hide the skydome. */
  setVisible(visible: boolean): void;
  /** Dispose the dome mesh, material, and texture (and detach any follower). */
  dispose(): void;
}

/** Options for {@link showGazeSkydome}, a one-call fetch-and-render gaze skydome. */
export interface ShowGazeSkydomeOptions extends FetchGazeHeatmapOptions {
  /** Scene to draw the gaze skydome into. */
  scene: Scene;
  /** Base name for the created mesh/material/texture (default `"uptimizr-gaze-sky"`). */
  name?: string;
  /** Dome radius in world units (default `50`). Make it larger than the scene. */
  radius?: number;
  /** Sphere tessellation (default `32`). Higher = smoother dome. */
  segments?: number;
  /** Rendering group for the dome mesh (default `0`). */
  renderingGroupId?: number;
  /** Equirectangular texture knobs (size, ramp, blur, alpha). */
  texture?: GazeEquirectOptions;
  /**
   * Keep the dome centered on this camera every frame, so the developer stands
   * inside the gaze field. Natural in WebXR — look around to see what others
   * looked at. When omitted the dome sits at the world origin.
   */
  followCamera?: Camera;
}

/**
 * Fetch a gaze (camera view-direction) heatmap and render it as a **continuous**
 * equirectangular heat field on an inward-facing skydome centered on the camera.
 * The polished counterpart to {@link showGazeDome}'s discrete markers (design
 * §7.6): {@link buildGazeEquirect} splats the bins into a texture which is mapped
 * onto a back-faced sphere so the developer can stand inside the distribution.
 */
export async function showGazeSkydome(options: ShowGazeSkydomeOptions): Promise<GazeSkydomeHandle> {
  const data = await fetchGazeHeatmap(options);
  const scene = options.scene;
  const name = options.name ?? "uptimizr-gaze-sky";
  const radius = options.radius !== undefined && options.radius > 0 ? options.radius : 50;
  const segments = options.segments !== undefined && options.segments > 0 ? options.segments : 32;

  // Inward-facing sphere: BACKSIDE flips the winding so we see the inner surface.
  const dome = MeshBuilder.CreateSphere(
    name,
    { diameter: radius * 2, segments, sideOrientation: Mesh.BACKSIDE },
    scene,
  );
  dome.isPickable = false;
  dome.infiniteDistance = false;
  dome.renderingGroupId = options.renderingGroupId ?? 0;

  const first = buildGazeEquirect(data, options.texture);
  const texture = new DynamicTexture(
    `${name}-tex`,
    { width: first.width, height: first.height },
    scene,
    false,
  );
  texture.hasAlpha = true;

  const upload = (tex: ReturnType<typeof buildGazeEquirect>): void => {
    const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
    const image = ctx.createImageData(tex.width, tex.height);
    image.data.set(tex.rgba);
    ctx.putImageData(image, 0, 0);
    texture.update();
  };
  upload(first);

  const material = new StandardMaterial(`${name}-mat`, scene);
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveTexture = texture;
  material.opacityTexture = texture; // alpha channel → empty sky shows the scene
  material.backFaceCulling = true;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  dome.material = material;

  let observer: ReturnType<Scene["onBeforeRenderObservable"]["add"]> | null = null;
  const camera = options.followCamera;
  if (camera) {
    dome.position.copyFrom(camera.globalPosition);
    observer = scene.onBeforeRenderObservable.add(() => {
      dome.position.copyFrom(camera.globalPosition);
    });
  }

  return {
    render(next: GazeData): void {
      upload(buildGazeEquirect(next, options.texture));
    },
    setVisible(visible: boolean): void {
      dome.setEnabled(visible);
    },
    dispose(): void {
      if (observer) scene.onBeforeRenderObservable.remove(observer);
      material.dispose();
      texture.dispose();
      dome.dispose();
    },
  };
}
