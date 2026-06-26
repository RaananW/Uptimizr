// Cross-engine "expanse" scene (three.js): the large, walkable, multi-level world
// (ADR 0040) rendered with three.js. three ships no walkable physics, so the
// geometry, the analytic floor height (for climbing the ramp/overlook/tower floors),
// the horizontal collision, and the section boxes all come from the shared
// `./layout.ts` — so this build exercises the same large-scene analytics path
// (bounds-driven cell size, region drill-down, coverage/cold-spots, and `setScene`
// section switching) as the Babylon reference. Navigation is PointerLockControls +
// WASD (click to lock); three can't tell orbit from free-fly, so the session is
// tagged `cameraType: "free"` (ADR 0026).

import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from "three";
import type { Object3D } from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";

import { createThreeEngineModule, type ThreeSceneSetup } from "../../engines/three.js";
import type { EngineMountContext } from "../../engine.js";
import { mountLockOverlay } from "../../lock-overlay.js";
import {
  DEFAULT_SCENE_ID,
  EYE_HEIGHT,
  GROUND,
  SECTIONS,
  SLABS,
  SPAWN,
  floorHeightAt,
  resolveWalk,
} from "./layout.js";

const MOVE_SPEED = 14; // units/second — the world is large.

function buildExpanseScene(canvas: HTMLCanvasElement, _ctx: EngineMountContext): ThreeSceneSetup {
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new Scene();
  scene.background = new Color(0x0b0e14);

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(SPAWN.x, EYE_HEIGHT, SPAWN.z);
  camera.rotation.set(0, Math.PI, 0); // face north (+Z), up the long axis

  scene.add(new HemisphereLight(0xffffff, 0x303a4a, 0.95));
  const sun = new DirectionalLight(0xffffff, 0.55);
  sun.position.set(-40, 100, 35);
  scene.add(sun);

  const ground = new Mesh(
    new PlaneGeometry(GROUND.width, GROUND.depth),
    new MeshStandardMaterial({
      color: new Color(GROUND.color[0], GROUND.color[1], GROUND.color[2]),
    }),
  );
  ground.name = "ground";
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const pickTargets: Object3D[] = [];
  for (const slab of SLABS) {
    const mesh = new Mesh(
      new BoxGeometry(slab.sx, slab.sy, slab.sz),
      new MeshStandardMaterial({ color: new Color(slab.color[0], slab.color[1], slab.color[2]) }),
    );
    mesh.name = slab.name;
    mesh.position.set(slab.x, slab.y, slab.z);
    if (slab.rotXDeg !== 0) mesh.rotation.x = (slab.rotXDeg * Math.PI) / 180;
    scene.add(mesh);
    if (slab.pickable) pickTargets.push(mesh);
  }

  // PointerLock + WASD first-person controller with height-field walking. Engage the
  // lock from an overlay prompt (not the canvas) so the mode-entry click is not
  // recorded as an in-scene `pointer_click` (the connector listens on the canvas).
  const controls = new PointerLockControls(camera, renderer.domElement);
  const lockOverlay = mountLockOverlay(renderer.domElement, () => controls.lock());

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

  let floorY = 0;
  function update(dt: number): void {
    if (!controls.isLocked) return;
    const dist = MOVE_SPEED * dt;
    if (keys.forward) controls.moveForward(dist);
    if (keys.back) controls.moveForward(-dist);
    if (keys.right) controls.moveRight(dist);
    if (keys.left) controls.moveRight(-dist);
    const resolved = resolveWalk(camera.position.x, camera.position.z, floorY);
    camera.position.x = resolved.x;
    camera.position.z = resolved.z;
    const target = floorHeightAt(resolved.x, resolved.z, floorY);
    floorY += (target - floorY) * Math.min(1, dt * 12);
    camera.position.y = floorY + EYE_HEIGHT;
  }

  function disposeScene(): void {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    lockOverlay.dispose();
    controls.dispose();
  }

  return {
    scene,
    camera,
    renderer,
    pickTargets,
    isPickable: (name) => name.startsWith("landmark-"),
    pickEvent: "landmark_picked",
    update,
    disposeScene,
    cameraType: "free",
    sections: SECTIONS,
    defaultSceneId: DEFAULT_SCENE_ID,
  };
}

export const engine = createThreeEngineModule({ build: buildExpanseScene });
