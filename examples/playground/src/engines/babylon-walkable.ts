// Babylon.js first-person "walkable" scene: a large room with walls, a handful of
// interactable item pedestals, and an ambient NPC that patrols a loop. It uses a
// `UniversalCamera` (WASD + mouse look + collisions + gravity), which the
// `@uptimizr/babylon` connector auto-classifies as `cameraType: "free"` — the
// first-person navigation model the dashboard segments on (see ADR 0026).

import "@babylonjs/loaders/glTF";
import "@babylonjs/core/Collisions/collisionCoordinator.js";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { Engine } from "@babylonjs/core/Engines/engine.js";
import type { Scene as BabylonScene } from "@babylonjs/core/scene.js";

import { assetUrl } from "../assets.js";

import { BOX_COLORS } from "../engine.js";

/** Half-extent of the square floor; the room spans [-ROOM, ROOM] on X and Z. */
const ROOM = 28;
const WALL_HEIGHT = 6;
const WALL_THICKNESS = 1;
const EYE_HEIGHT = 1.8;

function makeMaterial(
  scene: BabylonScene,
  name: string,
  rgb: [number, number, number],
): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = new Color3(rgb[0], rgb[1], rgb[2]);
  return mat;
}

/** A collidable wall slab centred at (x,z) with the given size. */
function addWall(
  scene: BabylonScene,
  name: string,
  x: number,
  z: number,
  width: number,
  depth: number,
  mat: StandardMaterial,
): void {
  const wall = CreateBox(name, { width, height: WALL_HEIGHT, depth }, scene);
  wall.position.set(x, WALL_HEIGHT / 2, z);
  wall.material = mat;
  wall.checkCollisions = true;
}

/**
 * Build the walkable first-person scene. The NPC patrol is driven by a
 * `scene.onBeforeRenderObservable` hook registered here, so the caller only needs
 * to render the scene each frame.
 *
 * Pass `skipDefaultItems` to omit the coloured demo boxes (but keep the pedestals)
 * — the `gallery` scene uses this to place real glTF models on the same spots. The
 * returned `itemSpots` are the pedestal `[x, z]` positions in placement order.
 */
export function buildWalkableScene(
  engine: Engine,
  canvas: HTMLCanvasElement,
  options?: { skipDefaultItems?: boolean },
): { scene: BabylonScene; camera: Camera; itemSpots: Array<[number, number]> } {
  const scene = new Scene(engine);
  scene.collisionsEnabled = true;
  scene.gravity = new Vector3(0, -0.45, 0);

  // First-person rig: eye-height camera with WASD, mouse look, gravity + collisions.
  const camera = new UniversalCamera("camera", new Vector3(0, EYE_HEIGHT, -ROOM + 4), scene);
  camera.setTarget(new Vector3(0, EYE_HEIGHT, 0));
  camera.attachControl(canvas, true);
  camera.speed = 0.45;
  camera.angularSensibility = 4000;
  camera.minZ = 0.1;
  camera.checkCollisions = true;
  camera.applyGravity = true;
  camera.ellipsoid = new Vector3(0.8, EYE_HEIGHT / 2, 0.8);
  // WASD movement (Babylon defaults to arrow keys).
  camera.keysUp = [87]; // W
  camera.keysDown = [83]; // S
  camera.keysLeft = [65]; // A
  camera.keysRight = [68]; // D

  const hemi = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.95;

  // Floor.
  const ground = CreateGround("ground", { width: ROOM * 2, height: ROOM * 2 }, scene);
  ground.material = makeMaterial(scene, "groundMat", [0.12, 0.14, 0.2]);
  ground.checkCollisions = true;

  // Perimeter walls + two interior dividers to make the space feel like rooms.
  const wallMat = makeMaterial(scene, "wallMat", [0.22, 0.26, 0.34]);
  addWall(scene, "wall-n", 0, ROOM, ROOM * 2, WALL_THICKNESS, wallMat);
  addWall(scene, "wall-s", 0, -ROOM, ROOM * 2, WALL_THICKNESS, wallMat);
  addWall(scene, "wall-e", ROOM, 0, WALL_THICKNESS, ROOM * 2, wallMat);
  addWall(scene, "wall-w", -ROOM, 0, WALL_THICKNESS, ROOM * 2, wallMat);
  // Interior partitions (with gaps so the visitor can walk between rooms).
  const dividerMat = makeMaterial(scene, "dividerMat", [0.18, 0.21, 0.28]);
  addWall(scene, "wall-div-1", -8, 6, WALL_THICKNESS, ROOM - 6, dividerMat);
  addWall(scene, "wall-div-2", 10, -6, WALL_THICKNESS, ROOM - 6, dividerMat);

  // Interactable item pedestals scattered through the rooms. Named `item-N` so the
  // engine's pick handler reports them as custom events (and the connector captures
  // the mesh interaction for the floor-plan/replay).
  const itemSpots: Array<[number, number]> = [
    [-18, 16],
    [16, 16],
    [-18, -16],
    [18, -14],
    [2, 0],
  ];
  itemSpots.forEach(([x, z], i) => {
    const pedestal = CreateBox(`pedestal-${i}`, { width: 2, height: 1, depth: 2 }, scene);
    pedestal.position.set(x, 0.5, z);
    pedestal.material = makeMaterial(scene, `pedestalMat-${i}`, [0.16, 0.18, 0.24]);
    pedestal.checkCollisions = true;
    if (!options?.skipDefaultItems) {
      const rgb = BOX_COLORS[i % BOX_COLORS.length] ?? [0.8, 0.8, 0.8];
      const item = CreateBox(`item-${i}`, { size: 1.4 }, scene);
      item.position.set(x, 1.7, z);
      item.material = makeMaterial(scene, `itemMat-${i}`, rgb);
    }
  });

  // Ambient NPC: a rigged, animated humanoid (Khronos `RiggedFigure`, CC BY 4.0)
  // parented to a patrol node named `npc` so the connector resolves it as a
  // `node_transform` actor (ADR 0027). The glTF loads asynchronously and its baked
  // walk animation groups loop via the scene render loop; until it arrives the
  // (empty) patrol node still walks the loop.
  const npc = new TransformNode("npc", scene);
  void LoadAssetContainerAsync(assetUrl("models/RiggedFigure.glb"), scene)
    .then((container) => {
      container.addAllToScene();
      let min = new Vector3(Infinity, Infinity, Infinity);
      let max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (const mesh of container.meshes) {
        if (mesh.getTotalVertices() === 0) continue;
        mesh.computeWorldMatrix(true);
        const box = mesh.getBoundingInfo().boundingBox;
        min = Vector3.Minimize(min, box.minimumWorld);
        max = Vector3.Maximize(max, box.maximumWorld);
      }
      const scale = 2 / (max.y - min.y || 1); // normalize to ~2 units tall
      const figure = new TransformNode("npc-figure", scene);
      for (const node of container.rootNodes) node.parent = figure;
      figure.scaling.setAll(scale);
      figure.position.y = -min.y * scale; // sit feet on the patrol node
      figure.parent = npc;
      for (const group of container.animationGroups) group.play(true);
    })
    .catch(() => {
      /* demo asset is optional — patrol still runs without a visible mesh */
    });

  const waypoints = [
    new Vector3(-14, 0, -14),
    new Vector3(14, 0, -14),
    new Vector3(14, 0, 14),
    new Vector3(-14, 0, 14),
  ];
  let target = 0;
  npc.position.copyFrom(waypoints[0] as Vector3);
  const npcSpeed = 2.2; // units/second
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    const dest = waypoints[target] as Vector3;
    const toDest = dest.subtract(npc.position);
    const dist = toDest.length();
    if (dist < 0.2) {
      target = (target + 1) % waypoints.length;
    } else {
      const step = Math.min(npcSpeed * dt, dist);
      npc.position.addInPlace(toDest.scale(step / dist));
      npc.rotation.y = Math.atan2(toDest.x, toDest.z);
    }
  });

  return { scene, camera, itemSpots };
}
