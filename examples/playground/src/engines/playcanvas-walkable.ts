// PlayCanvas first-person "walkable" scene: a large room with walls, interactable
// item pedestals, and an ambient NPC patrolling a loop. Navigation is a small
// pointer-lock FPS controller (WASD + mouse look). PlayCanvas camera entities carry
// no orbit-vs-free-fly distinction, so the engine module declares
// `cameraType: "free"` on the session (ADR 0026).

import * as pc from "playcanvas";

import { BOX_COLORS } from "../engine.js";
import { assetUrl } from "../assets.js";
import { mountLockOverlay } from "../lock-overlay.js";

const ROOM = 28;
const WALL_HEIGHT = 6;
const EYE_HEIGHT = 1.8;
const MOVE_SPEED = 6;
const LOOK_SENS = 0.12;

export interface WalkablePlayCanvasScene {
  app: pc.Application;
  camera: pc.Entity;
  /** Item materials keyed by entity name, for the click flash. */
  materials: Map<string, pc.StandardMaterial>;
  /** Pedestal `[x, z]` positions in placement order (for the gallery's models). */
  itemSpots: Array<[number, number]>;
  dispose(): void;
}

function solidMaterial(rgb: [number, number, number]): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  mat.diffuse = new pc.Color(rgb[0], rgb[1], rgb[2]);
  mat.update();
  return mat;
}

function addWall(app: pc.Application, x: number, z: number, w: number, d: number): void {
  const wall = new pc.Entity(`wall-${x}-${z}`);
  wall.addComponent("render", { type: "box", material: solidMaterial([0.22, 0.26, 0.34]) });
  wall.setLocalScale(w, WALL_HEIGHT, d);
  wall.setPosition(x, WALL_HEIGHT / 2, z);
  app.root.addChild(wall);
}

export function buildWalkableScene(
  canvas: HTMLCanvasElement,
  options?: { skipDefaultItems?: boolean },
): WalkablePlayCanvasScene {
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
    farClip: 200,
  });
  camera.setPosition(0, EYE_HEIGHT, -ROOM + 4);
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
  ground.addComponent("render", { type: "plane", material: solidMaterial([0.12, 0.14, 0.2]) });
  ground.setLocalScale(ROOM * 2, 1, ROOM * 2);
  app.root.addChild(ground);

  addWall(app, 0, ROOM, ROOM * 2, 1);
  addWall(app, 0, -ROOM, ROOM * 2, 1);
  addWall(app, ROOM, 0, 1, ROOM * 2);
  addWall(app, -ROOM, 0, 1, ROOM * 2);
  addWall(app, -8, 6, 1, ROOM - 6);
  addWall(app, 10, -6, 1, ROOM - 6);

  const materials = new Map<string, pc.StandardMaterial>();
  const itemSpots: Array<[number, number]> = [
    [-18, 16],
    [16, 16],
    [-18, -16],
    [18, -14],
    [2, 0],
  ];
  itemSpots.forEach(([x, z], i) => {
    const pedestal = new pc.Entity(`pedestal-${i}`);
    pedestal.addComponent("render", { type: "box", material: solidMaterial([0.16, 0.18, 0.24]) });
    pedestal.setLocalScale(2, 1, 2);
    pedestal.setPosition(x, 0.5, z);
    app.root.addChild(pedestal);
    if (!options?.skipDefaultItems) {
      const rgb = BOX_COLORS[i % BOX_COLORS.length] ?? [0.8, 0.8, 0.8];
      const itemMat = solidMaterial(rgb);
      const name = `item-${i}`;
      const item = new pc.Entity(name);
      item.addComponent("render", { type: "box", material: itemMat });
      item.setLocalScale(1.4, 1.4, 1.4);
      item.setPosition(x, 1.7, z);
      app.root.addChild(item);
      materials.set(name, itemMat);
    }
  });

  // Ambient NPC: a rigged, animated humanoid (Khronos `RiggedFigure`, CC BY 4.0)
  // parented to a patrol node named `npc` so the connector resolves it as a
  // `node_transform` actor (ADR 0027). The glTF container loads asynchronously and
  // its baked walk animation loops via an `anim` component; until it arrives the
  // (empty) patrol node still walks the loop.
  const npc = new pc.Entity("npc");
  app.root.addChild(npc);
  const figureAsset = new pc.Asset("npc-figure", "container", { url: assetUrl("models/RiggedFigure.glb") });
  app.assets.add(figureAsset);
  figureAsset.once("load", () => {
    const container = figureAsset.resource as pc.ContainerResource;
    const figure = container.instantiateRenderEntity();
    figure.name = "npc-figure";
    npc.addChild(figure);
    app.root.syncHierarchy();
    const meshInstances = (figure.findComponents("render") as pc.RenderComponent[]).flatMap(
      (r) => r.meshInstances,
    );
    const aabb = new pc.BoundingBox();
    const first = meshInstances[0];
    if (first) {
      aabb.copy(first.aabb);
      for (let i = 1; i < meshInstances.length; i++) {
        const mi = meshInstances[i];
        if (mi) aabb.add(mi.aabb);
      }
    }
    const scale = 2 / (aabb.halfExtents.y * 2 || 1); // normalize to ~2 units tall
    figure.setLocalScale(scale, scale, scale);
    const minY = aabb.center.y - aabb.halfExtents.y;
    figure.setLocalPosition(0, -minY * scale, 0); // sit feet on the patrol node
    // glTF containers expose their animation assets at runtime, but the type omits
    // `animations`; assign the first track to a default single-state graph (loops).
    const animations = (container as unknown as { animations?: pc.Asset[] }).animations;
    const track = animations?.[0]?.resource as unknown as pc.AnimTrack | undefined;
    if (track) {
      figure.addComponent("anim", { activate: true });
      figure.anim?.assignAnimation("Walk", track);
    }
  });
  figureAsset.once("error", () => {
    /* demo asset is optional — patrol still runs without a visible mesh */
  });
  app.assets.load(figureAsset);

  const waypoints: Array<[number, number]> = [
    [-14, -14],
    [14, -14],
    [14, 14],
    [-14, 14],
  ];
  let target = 0;
  npc.setPosition(waypoints[0]![0], 0, waypoints[0]![1]);
  const npcSpeed = 2.2;

  // Pointer-lock FPS controller (yaw/pitch + WASD).
  let yaw = 180;
  let pitch = 0;
  const onMouseMove = (e: pc.MouseEvent): void => {
    if (!pc.Mouse.isPointerLocked()) return;
    yaw -= e.dx * LOOK_SENS;
    pitch = Math.max(-89, Math.min(89, pitch - e.dy * LOOK_SENS));
  };
  app.mouse?.on(pc.EVENT_MOUSEMOVE, onMouseMove);
  // Engage pointer lock from an overlay prompt rather than the canvas itself, so
  // the mode-entry click is NOT recorded as an in-scene `pointer_click` (the
  // analytics connector listens on the canvas).
  //
  // Lock the canvas directly (as three.js does) instead of PlayCanvas's built-in
  // `app.mouse.enablePointerLock()`, which locks `document.body`. Body-locking is
  // rejected by the browser when the demo runs the scene inside an iframe ("the
  // root document of this element is not valid for pointer lock"), so mouse-look
  // never engaged. PlayCanvas's mouse handler only checks `isPointerLocked()`, so
  // it still reads movement deltas once the canvas holds the lock.
  const lockOverlay = mountLockOverlay(canvas, () => {
    Promise.resolve(canvas.requestPointerLock()).catch(() => {
      /* lock can be refused (e.g. user gesture lost); the overlay stays up */
    });
  });

  const bound = ROOM - 1.2;
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
      pos.x = Math.max(-bound, Math.min(bound, pos.x));
      pos.z = Math.max(-bound, Math.min(bound, pos.z));
      camera.setPosition(pos.x, EYE_HEIGHT, pos.z);
    }
    // Advance the NPC.
    const dest = waypoints[target]!;
    const np = npc.getPosition();
    const dx = dest[0] - np.x;
    const dz = dest[1] - np.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.2) {
      target = (target + 1) % waypoints.length;
    } else {
      const step = (npcSpeed * dt) / d;
      npc.setPosition(np.x + dx * step, 0, np.z + dz * step);
      npc.setEulerAngles(0, (Math.atan2(dx, dz) * 180) / Math.PI, 0);
    }
  };
  app.on("update", onUpdate);

  app.start();

  function dispose(): void {
    window.removeEventListener("resize", onResize);
    lockOverlay.dispose();
    app.mouse?.off(pc.EVENT_MOUSEMOVE, onMouseMove);
    app.off("update", onUpdate);
  }

  return { app, camera, materials, itemSpots, dispose };
}
