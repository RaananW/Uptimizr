// Cross-engine "expanse" scene (PlayCanvas): the large, walkable, multi-level world
// (ADR 0040) rendered with PlayCanvas. PlayCanvas ships no walkable physics here, so
// the geometry, the analytic floor height (for climbing the ramp/overlook/tower
// floors), the horizontal collision, and the section boxes all come from the shared
// `./layout.ts` — so this build exercises the same large-scene analytics path as the
// Babylon reference. Navigation is a small pointer-lock FPS controller (WASD + mouse
// look); PlayCanvas camera entities carry no orbit-vs-free distinction, so the session
// is tagged `cameraType: "free"` (ADR 0026).

import * as pc from "playcanvas";

import {
  createPlayCanvasEngineModule,
  type PlayCanvasSceneSetup,
} from "../../engines/playcanvas.js";
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

const MOVE_SPEED = 14;
const LOOK_SENS = 0.12;

function solidMaterial(rgb: readonly [number, number, number]): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  mat.diffuse = new pc.Color(rgb[0], rgb[1], rgb[2]);
  mat.update();
  return mat;
}

function buildExpanseScene(
  canvas: HTMLCanvasElement,
  _ctx: EngineMountContext,
): PlayCanvasSceneSetup {
  const app = new pc.Application(canvas, {
    mouse: new pc.Mouse(canvas),
    touch: new pc.TouchDevice(canvas),
    keyboard: new pc.Keyboard(window),
  });
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);
  const onResize = (): void => {
    app.resizeCanvas();
  };
  window.addEventListener("resize", onResize);

  const camera = new pc.Entity("mainCamera");
  camera.addComponent("camera", {
    clearColor: new pc.Color(0.043, 0.055, 0.078),
    fov: 70,
    nearClip: 0.1,
    farClip: 2000,
  });
  camera.setPosition(SPAWN.x, EYE_HEIGHT, SPAWN.z);
  app.root.addChild(camera);

  const hemi = new pc.Entity("hemiLight");
  hemi.addComponent("light", { type: "directional", intensity: 0.55 });
  hemi.setEulerAngles(60, 30, 0);
  app.root.addChild(hemi);
  const sun = new pc.Entity("sun");
  sun.addComponent("light", { type: "directional", intensity: 0.9 });
  sun.setEulerAngles(45, -40, 0);
  app.root.addChild(sun);

  const ground = new pc.Entity("ground");
  ground.addComponent("render", { type: "plane", material: solidMaterial(GROUND.color) });
  ground.setLocalScale(GROUND.width, 1, GROUND.depth);
  app.root.addChild(ground);

  for (const slab of SLABS) {
    const entity = new pc.Entity(slab.name);
    entity.addComponent("render", { type: "box", material: solidMaterial(slab.color) });
    entity.setLocalScale(slab.sx, slab.sy, slab.sz);
    entity.setPosition(slab.x, slab.y, slab.z);
    if (slab.rotXDeg !== 0) entity.setEulerAngles(slab.rotXDeg, 0, 0);
    app.root.addChild(entity);
  }

  // Pointer-lock FPS controller (yaw/pitch + WASD) with height-field walking.
  let yaw = 180; // face north (+Z)
  let pitch = 0;
  const onMouseMove = (e: pc.MouseEvent): void => {
    if (!pc.Mouse.isPointerLocked()) return;
    yaw -= e.dx * LOOK_SENS;
    pitch = Math.max(-89, Math.min(89, pitch - e.dy * LOOK_SENS));
  };
  app.mouse?.on(pc.EVENT_MOUSEMOVE, onMouseMove);
  // Lock the canvas directly (as three.js does) from an overlay prompt, so the
  // mode-entry click is not recorded as an in-scene `pointer_click`.
  const lockOverlay = mountLockOverlay(canvas, () => {
    Promise.resolve(canvas.requestPointerLock()).catch(() => {
      /* lock can be refused (e.g. user gesture lost); the overlay stays up */
    });
  });

  let floorY = 0;
  const onUpdate = (dt: number): void => {
    camera.setEulerAngles(pitch, yaw, 0);
    const kb = app.keyboard;
    if (kb && pc.Mouse.isPointerLocked()) {
      const dist = MOVE_SPEED * dt;
      const fwd = camera.forward.clone();
      fwd.y = 0;
      fwd.normalize();
      const right = camera.right.clone();
      right.y = 0;
      right.normalize();
      const pos = camera.getPosition().clone();
      if (kb.isPressed(pc.KEY_W)) pos.add(fwd.clone().mulScalar(dist));
      if (kb.isPressed(pc.KEY_S)) pos.add(fwd.clone().mulScalar(-dist));
      if (kb.isPressed(pc.KEY_D)) pos.add(right.clone().mulScalar(dist));
      if (kb.isPressed(pc.KEY_A)) pos.add(right.clone().mulScalar(-dist));
      const resolved = resolveWalk(pos.x, pos.z, floorY);
      const target = floorHeightAt(resolved.x, resolved.z, floorY);
      floorY += (target - floorY) * Math.min(1, dt * 12);
      camera.setPosition(resolved.x, floorY + EYE_HEIGHT, resolved.z);
    }
  };
  app.on("update", onUpdate);

  app.start();

  function disposeScene(): void {
    window.removeEventListener("resize", onResize);
    lockOverlay.dispose();
    app.mouse?.off(pc.EVENT_MOUSEMOVE, onMouseMove);
    app.off("update", onUpdate);
  }

  return {
    app,
    camera,
    isPickable: (name) => name.startsWith("landmark-"),
    pickEvent: "landmark_picked",
    cameraType: "free",
    disposeScene,
    sections: SECTIONS,
    defaultSceneId: DEFAULT_SCENE_ID,
  };
}

export const engine = createPlayCanvasEngineModule({ build: buildExpanseScene });
