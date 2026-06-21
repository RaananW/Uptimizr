// three.js first-person "walkable" scene: a large room with walls, interactable
// item pedestals, and an ambient NPC patrolling a loop. Navigation uses
// `PointerLockControls` + WASD (click to lock the pointer). three.js can't tell
// orbit from free-fly at the camera level, so the engine module declares
// `cameraType: "free"` on the session (ADR 0026).

import {
  AnimationMixer,
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";

import { BOX_COLORS } from "../engine.js";
import { assetUrl } from "../assets.js";
import { mountLockOverlay } from "../lock-overlay.js";

const ROOM = 28;
const WALL_HEIGHT = 6;
const EYE_HEIGHT = 1.8;
const MOVE_SPEED = 6; // units/second

export interface WalkableScene {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  controls: PointerLockControls;
  /** Objects the demo raycasts against (recursively) for the flash + custom event. */
  pickTargets: Object3D[];
  /** Pedestal `[x, z]` positions in placement order (for the gallery's models). */
  itemSpots: Array<[number, number]>;
  /** Per-frame update: integrate WASD movement and advance the NPC. */
  update(dt: number): void;
  /** Tear down listeners + controls. */
  dispose(): void;
}

function mat(rgb: [number, number, number]): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: new Color(rgb[0], rgb[1], rgb[2]) });
}

function addWall(scene: Scene, x: number, z: number, w: number, d: number): void {
  const wall = new Mesh(new BoxGeometry(w, WALL_HEIGHT, d), mat([0.22, 0.26, 0.34]));
  wall.position.set(x, WALL_HEIGHT / 2, z);
  scene.add(wall);
}

export function buildWalkableScene(
  canvas: HTMLCanvasElement,
  options?: { skipDefaultItems?: boolean },
): WalkableScene {
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new Scene();
  scene.background = new Color(0x0b0e14);

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, EYE_HEIGHT, -ROOM + 4);

  const controls = new PointerLockControls(camera, renderer.domElement);
  // Engage pointer lock from an overlay prompt rather than the canvas itself, so
  // the mode-entry click is NOT recorded as an in-scene `pointer_click` (the
  // analytics connector listens on the canvas).
  const lockOverlay = mountLockOverlay(renderer.domElement, () => controls.lock());

  scene.add(new HemisphereLight(0xffffff, 0x303a4a, 1.05));
  const sun = new DirectionalLight(0xffffff, 0.6);
  sun.position.set(8, 14, 6);
  scene.add(sun);

  const ground = new Mesh(new PlaneGeometry(ROOM * 2, ROOM * 2), mat([0.12, 0.14, 0.2]));
  ground.name = "ground";
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Perimeter + interior walls.
  addWall(scene, 0, ROOM, ROOM * 2, 1);
  addWall(scene, 0, -ROOM, ROOM * 2, 1);
  addWall(scene, ROOM, 0, 1, ROOM * 2);
  addWall(scene, -ROOM, 0, 1, ROOM * 2);
  addWall(scene, -8, 6, 1, ROOM - 6);
  addWall(scene, 10, -6, 1, ROOM - 6);

  // Interactable item pedestals.
  const itemSpots: Array<[number, number]> = [
    [-18, 16],
    [16, 16],
    [-18, -16],
    [18, -14],
    [2, 0],
  ];
  const pickTargets: Object3D[] = [];
  itemSpots.forEach(([x, z], i) => {
    const pedestal = new Mesh(new BoxGeometry(2, 1, 2), mat([0.16, 0.18, 0.24]));
    pedestal.position.set(x, 0.5, z);
    scene.add(pedestal);
    if (!options?.skipDefaultItems) {
      const rgb = BOX_COLORS[i % BOX_COLORS.length] ?? [0.8, 0.8, 0.8];
      const item = new Mesh(new BoxGeometry(1.4, 1.4, 1.4), mat(rgb));
      item.name = `item-${i}`;
      item.position.set(x, 1.7, z);
      scene.add(item);
      pickTargets.push(item);
    }
  });

  // Ambient NPC: a rigged, animated humanoid (Khronos `RiggedFigure`, CC BY 4.0)
  // parented to a patrol node. The node is named `npc` so the connector resolves it
  // as a `node_transform` actor (ADR 0027); the figure's baked walk cycle plays via
  // an AnimationMixer advanced in `update`. The glTF loads asynchronously, so the
  // patrol runs (moving an empty node) until the mesh pops in.
  const npc = new Group();
  npc.name = "npc";
  scene.add(npc);
  let npcMixer: AnimationMixer | null = null;
  void new GLTFLoader()
    .loadAsync(assetUrl("models/RiggedFigure.glb"))
    .then((gltf) => {
      const figure = gltf.scene;
      figure.name = "npc-figure";
      const box = new Box3().setFromObject(figure);
      const size = box.getSize(new Vector3());
      const scale = 2 / (size.y || 1); // normalize to ~2 units tall
      figure.scale.setScalar(scale);
      figure.position.y = -box.min.y * scale; // sit feet on the patrol node
      npc.add(figure);
      const clip = gltf.animations[0];
      if (clip) {
        npcMixer = new AnimationMixer(figure);
        npcMixer.clipAction(clip).play();
      }
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
  npc.position.copy(waypoints[0] as Vector3);
  let target = 0;
  const npcSpeed = 2.2;

  // WASD movement state.
  const keys = { forward: false, back: false, left: false, right: false };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "KeyW") keys.forward = true;
    else if (e.code === "KeyS") keys.back = true;
    else if (e.code === "KeyA") keys.left = true;
    else if (e.code === "KeyD") keys.right = true;
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "KeyW") keys.forward = false;
    else if (e.code === "KeyS") keys.back = false;
    else if (e.code === "KeyA") keys.left = false;
    else if (e.code === "KeyD") keys.right = false;
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const bound = ROOM - 1.2;
  function update(dt: number): void {
    if (controls.isLocked) {
      const dist = MOVE_SPEED * dt;
      if (keys.forward) controls.moveForward(dist);
      if (keys.back) controls.moveForward(-dist);
      if (keys.right) controls.moveRight(dist);
      if (keys.left) controls.moveRight(-dist);
      // Keep the visitor inside the room and at eye height.
      camera.position.x = Math.max(-bound, Math.min(bound, camera.position.x));
      camera.position.z = Math.max(-bound, Math.min(bound, camera.position.z));
      camera.position.y = EYE_HEIGHT;
    }
    // Advance the NPC along its patrol loop and tick its walk animation.
    npcMixer?.update(dt);
    const dest = waypoints[target] as Vector3;
    const toDest = dest.clone().sub(npc.position);
    const d = toDest.length();
    if (d < 0.2) {
      target = (target + 1) % waypoints.length;
    } else {
      npc.position.add(toDest.multiplyScalar((npcSpeed * dt) / d));
      npc.rotation.y = Math.atan2(toDest.x, toDest.z);
    }
  }

  function dispose(): void {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    lockOverlay.dispose();
    controls.dispose();
  }

  return { scene, camera, renderer, controls, pickTargets, itemSpots, update, dispose };
}
