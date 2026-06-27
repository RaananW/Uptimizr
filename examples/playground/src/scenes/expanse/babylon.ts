// Cross-engine "expanse" scene (Babylon.js): a deliberately **large**, walkable,
// multi-level world built to exercise the ADR 0040 large-scene analytics path —
// bounds-driven cell size, region drill-down, and coverage/cold-spots — on a real
// captured session instead of a synthetic fixture.
//
// The world spans ~360 × 560 world units (≈10× the atrium's 56 × 56 walkable area),
// so the registered scene `bounds` (ADR 0014) are genuinely large and the
// bounds-driven default `cellSize` (ADR 0040 §1) actually kicks in. It has real
// vertical traversal — a ramp up to a raised overlook terrace and a three-floor
// tower joined by internal ramps — plus landmarks scattered far apart and an
// out-of-the-way "gardens" corner that stays cold unless a visitor seeks it out
// (so coverage / cold-spot signals are meaningful).
//
// It also declares **sections** (ADR 0040 §5): as the visitor crosses a section's
// box the connector calls `client.setScene(...)`, so one continuous space is
// tracked as distinct, semantically-named areas (plaza / ramp / overlook / tower
// floors / gardens) you can filter and segment on — a manual test bed for scene
// changes within a single project. Reuses the shared Babylon connector wiring via
// `createBabylonEngineModule`; only the geometry + section boxes are custom.

import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera.js";
import "@babylonjs/core/Collisions/collisionCoordinator.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import type { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { Scene as BabylonScene } from "@babylonjs/core/scene.js";

import {
  createBabylonEngineModule,
  type BabylonSceneSetup,
  type SceneSection,
} from "../../engines/babylon.js";
import { BOX_COLORS, type EngineMountContext } from "../../engine.js";

/** World half-extents: the ground spans [-HALF_X, HALF_X] × [-HALF_Z, HALF_Z]. */
const HALF_X = 180;
const HALF_Z = 280;
const EYE_HEIGHT = 1.8;
const WALL_HEIGHT = 8;

/** Raised overlook terrace (north): a platform the ramp climbs to. */
const OVERLOOK_Y = 12;
/** Per-floor rise of the three-floor tower (floors at y = 0, 6, 12). */
const FLOOR_RISE = 6;

function mat(scene: BabylonScene, name: string, rgb: [number, number, number]): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = new Color3(rgb[0], rgb[1], rgb[2]);
  return m;
}

/** A collidable axis-aligned slab centred at (x, y, z). */
function slab(
  scene: BabylonScene,
  name: string,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  material: StandardMaterial,
): void {
  const box = CreateBox(name, { width, height, depth }, scene);
  box.position.set(x, y, z);
  box.material = material;
  box.checkCollisions = true;
}

/**
 * A pickable landmark (a tall obelisk on a base) named `landmark-N` so the shared
 * pick handler flashes it and emits a `landmark_picked` custom event. Landmarks are
 * placed far apart so the heatmap's far-area coverage is the interesting question.
 */
function landmark(
  scene: BabylonScene,
  index: number,
  x: number,
  z: number,
  baseY: number,
  material: StandardMaterial,
): void {
  const base = CreateBox(`pedestal-${index}`, { width: 3, height: 1, depth: 3 }, scene);
  base.position.set(x, baseY + 0.5, z);
  base.material = material;
  base.checkCollisions = true;

  const obelisk = CreateBox(`landmark-${index}`, { width: 1.4, height: 5, depth: 1.4 }, scene);
  obelisk.position.set(x, baseY + 1 + 2.5, z);
  const rgb = BOX_COLORS[index % BOX_COLORS.length] ?? [0.8, 0.8, 0.8];
  obelisk.material = mat(scene, `landmarkMat-${index}`, rgb);
}

/**
 * An inclined collidable ramp from `(x, fromY, fromZ)` up to `(x, toY, toZ)`. The
 * visitor's gravity + ellipsoid let a `UniversalCamera` walk up the gentle slope.
 */
function ramp(
  scene: BabylonScene,
  name: string,
  x: number,
  fromY: number,
  fromZ: number,
  toY: number,
  toZ: number,
  width: number,
  material: StandardMaterial,
): void {
  const runZ = toZ - fromZ;
  const rise = toY - fromY;
  const length = Math.hypot(runZ, rise);
  const box = CreateBox(name, { width, height: 0.6, depth: length }, scene);
  box.position.set(x, (fromY + toY) / 2, (fromZ + toZ) / 2);
  // Rotate about X so the +Z end rises by `rise` over `runZ` (negative tilts up north).
  box.rotation.x = -Math.atan2(rise, runZ);
  box.material = material;
  box.checkCollisions = true;
}

function buildExpanseScene(engine: Engine, ctx: EngineMountContext): BabylonSceneSetup {
  const scene = new Scene(engine);
  scene.collisionsEnabled = true;
  scene.gravity = new Vector3(0, -0.6, 0);

  // First-person rig: spawn at the south edge of the plaza, facing north (+Z) up
  // the long axis of the world. WASD + mouse look + gravity + collisions.
  const camera = new UniversalCamera("camera", new Vector3(0, EYE_HEIGHT, -HALF_Z + 20), scene);
  camera.setTarget(new Vector3(0, EYE_HEIGHT, -HALF_Z + 60));
  camera.attachControl(ctx.canvas, true);
  camera.speed = 0.8; // a touch faster — the world is large.
  camera.angularSensibility = 4000;
  camera.minZ = 0.1;
  camera.maxZ = 2000; // see clear across the large world.
  camera.checkCollisions = true;
  camera.applyGravity = true;
  camera.ellipsoid = new Vector3(0.8, EYE_HEIGHT / 2, 0.8);
  camera.keysUp = [87]; // W
  camera.keysDown = [83]; // S
  camera.keysLeft = [65]; // A
  camera.keysRight = [68]; // D

  const hemi = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.85;
  const key = new DirectionalLight("key", new Vector3(-0.4, -1, 0.35), scene);
  key.intensity = 0.55;

  // Ground covering the whole world.
  const ground = CreateGround("ground", { width: HALF_X * 2, height: HALF_Z * 2 }, scene);
  ground.material = mat(scene, "groundMat", [0.12, 0.14, 0.2]);
  ground.checkCollisions = true;

  // Perimeter walls so the world is bounded (and the registered AABB is well-defined).
  const wallMat = mat(scene, "wallMat", [0.2, 0.24, 0.32]);
  slab(scene, "wall-n", 0, WALL_HEIGHT / 2, HALF_Z, HALF_X * 2, WALL_HEIGHT, 2, wallMat);
  slab(scene, "wall-s", 0, WALL_HEIGHT / 2, -HALF_Z, HALF_X * 2, WALL_HEIGHT, 2, wallMat);
  slab(scene, "wall-e", HALF_X, WALL_HEIGHT / 2, 0, 2, WALL_HEIGHT, HALF_Z * 2, wallMat);
  slab(scene, "wall-w", -HALF_X, WALL_HEIGHT / 2, 0, 2, WALL_HEIGHT, HALF_Z * 2, wallMat);

  // --- Plaza (south + centre, ground level) ----------------------------------
  const plazaMat = mat(scene, "plazaMat", [0.16, 0.18, 0.24]);
  landmark(scene, 0, -120, -220, 0, plazaMat);
  landmark(scene, 1, 120, -220, 0, plazaMat);
  landmark(scene, 2, 0, -120, 0, plazaMat);
  landmark(scene, 3, -60, -40, 0, plazaMat);
  // A couple of low buildings to give the plaza structure (and coverage variation).
  slab(scene, "block-1", -90, 5, -120, 30, 10, 30, wallMat);
  slab(scene, "block-2", 70, 7, -90, 26, 14, 26, wallMat);

  // --- Ramp up to the raised overlook terrace (north) -------------------------
  const rampMat = mat(scene, "rampMat", [0.22, 0.2, 0.16]);
  ramp(scene, "ramp-overlook", 0, 0, 40, OVERLOOK_Y, 140, 20, rampMat);

  // --- Overlook terrace (north, elevated) -------------------------------------
  const overlookMat = mat(scene, "overlookMat", [0.18, 0.2, 0.26]);
  // Platform top sits at OVERLOOK_Y; build a 1-unit slab with its top there.
  slab(scene, "overlook-deck", 0, OVERLOOK_Y - 0.5, 210, 160, 1, 140, overlookMat);
  // Perimeter railings with a gap at the ramp mouth (z = 140) on the south edge.
  const railMat = mat(scene, "railMat", [0.26, 0.3, 0.4]);
  slab(scene, "rail-n", 0, OVERLOOK_Y + 0.75, 280, 160, 1.5, 1, railMat);
  slab(scene, "rail-e", 80, OVERLOOK_Y + 0.75, 210, 1, 1.5, 140, railMat);
  slab(scene, "rail-w", -80, OVERLOOK_Y + 0.75, 210, 1, 1.5, 140, railMat);
  landmark(scene, 4, -60, 250, OVERLOOK_Y, overlookMat);
  landmark(scene, 5, 60, 250, OVERLOOK_Y, overlookMat);

  // --- Tower (east), three open floors joined by internal ramps ---------------
  const towerMat = mat(scene, "towerMat", [0.2, 0.22, 0.3]);
  const towerCx = 137;
  // Each upper floor is split around an open stairwell so the internal ramp leads
  // all the way onto it: an open slot above the arriving ramp (no ceiling to bonk
  // your head on while climbing) plus a solid landing where the ramp tops out.
  // Ground floor (L1) uses the world ground. Floor 2 (y≈6): stairwell over ramp-1
  // in the west lane; Floor 3 (y≈12): stairwell over ramp-2 in the east lane.
  slab(scene, "tower-floor-2-w", towerCx - 31, FLOOR_RISE - 0.4, 10, 8, 0.8, 90, towerMat);
  slab(scene, "tower-floor-2-e", towerCx + 13, FLOOR_RISE - 0.4, 10, 44, 0.8, 90, towerMat);
  slab(scene, "tower-floor-2-n", towerCx - 18, FLOOR_RISE - 0.4, 47.5, 18, 0.8, 15, towerMat);
  slab(scene, "tower-floor-3-w", towerCx - 13, FLOOR_RISE * 2 - 0.4, 10, 44, 0.8, 90, towerMat);
  slab(scene, "tower-floor-3-e", towerCx + 31, FLOOR_RISE * 2 - 0.4, 10, 8, 0.8, 90, towerMat);
  slab(scene, "tower-floor-3-n", towerCx + 18, FLOOR_RISE * 2 - 0.4, 47.5, 18, 0.8, 15, towerMat);
  // Corner columns spanning the full height (visual framing + collision).
  for (const [cx, cz] of [
    [towerCx - 32, -33],
    [towerCx + 32, -33],
    [towerCx - 32, 53],
    [towerCx + 32, 53],
  ] as const) {
    slab(scene, `tower-col-${cx}-${cz}`, cx, FLOOR_RISE, cz, 2, FLOOR_RISE * 2 + 4, 2, towerMat);
  }
  // Internal ramps both rise north onto their floor's landing, offset on X (ramp-1
  // west → L2, ramp-2 east → L3): a switchback the visitor climbs through the open
  // stairwells, all the way up to the top floor.
  ramp(scene, "tower-ramp-1", towerCx - 18, 0, -30, FLOOR_RISE, 40, 14, rampMat);
  ramp(scene, "tower-ramp-2", towerCx + 18, FLOOR_RISE, -30, FLOOR_RISE * 2, 40, 14, rampMat);
  landmark(scene, 6, towerCx, 0, 30, towerMat);
  landmark(scene, 7, towerCx, FLOOR_RISE, 30, towerMat);
  landmark(scene, 8, towerCx, FLOOR_RISE * 2, 30, towerMat);

  // --- Gardens (far north-west corner) — intentionally out of the way ---------
  const hedgeMat = mat(scene, "hedgeMat", [0.14, 0.24, 0.16]);
  for (let i = 0; i < 4; i += 1) {
    slab(scene, `hedge-${i}`, -150 + (i % 2) * 24, 1, 170 + i * 22, 18, 2, 4, hedgeMat);
  }
  landmark(scene, 9, -140, 240, 0, hedgeMat);

  // Sections (ADR 0040 §5). Tested in order; the first box containing the camera
  // wins, else the visitor is in the plaza. Tower floors split on Y so each level
  // is its own tracked area.
  const sections: SceneSection[] = [
    { id: "expanse-tower-l3", aabb: [100, 10, -40, 175, 40, 60] },
    { id: "expanse-tower-l2", aabb: [100, 4, -40, 175, 10, 60] },
    { id: "expanse-tower-l1", aabb: [100, -1, -40, 175, 4, 60] },
    { id: "expanse-overlook", aabb: [-80, 10, 140, 80, 40, 280] },
    { id: "expanse-ramp", aabb: [-14, -1, 40, 14, 20, 140] },
    { id: "expanse-gardens", aabb: [-180, -1, 140, -100, 12, 280] },
  ];

  return {
    scene,
    camera,
    isPickable: (name) => name.startsWith("landmark-"),
    pickEvent: "landmark_picked",
    sections,
    defaultSceneId: "expanse-plaza",
    // The world is large: a coarse voxel keeps the overview heatmap legible instead
    // of dissolving into sub-pixel specks (ADR 0040 §1 — cellSize stays an explicit
    // override; here the scene picks one matched to its scale).
    heatmapCellSize: 6,
  };
}

export const engine = createBabylonEngineModule({ build: buildExpanseScene });
