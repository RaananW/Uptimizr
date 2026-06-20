import type { Collector, CollectorContext, CollectorHandle } from "@uptimizr/sdk-core";
import {
  toCanonicalDirection,
  toCanonicalPosition,
  xrHandedness,
  xrSource,
} from "@uptimizr/sdk-core";
import type { XrCaptureOptions, XrInputSourceLike, XrRayProbe } from "@uptimizr/sdk-core";
import type { Vec3 } from "@uptimizr/schema";

// Re-export the shared XR option/probe shapes so consumers can import them from the
// Babylon connector surface alongside the collector.
export type { XrCaptureOptions, XrRayHit, XrRayProbe } from "@uptimizr/sdk-core";

/**
 * WebXR controller / gaze capture for the Babylon.js connector.
 *
 * In an immersive session Babylon swaps in a `WebXRCamera`, so camera/gaze **pose**
 * keeps flowing through the regular {@link babylonCollector} passively. The gap this
 * collector fills is **controller input**, which never arrives through the scene's
 * `onPointerObservable`: it reads Babylon's `WebXRDefaultExperience` (the
 * `experience.input` controller registry + each controller's motion-controller
 * components) and maps live XR input onto the existing source-neutral schema events
 * (ADR 0011). Controller pose becomes `pointer_move` events carrying a world-space
 * `ray` (+ `source` / `handedness`); the controller **trigger** (`select`) becomes a
 * `pointer_click`, and a named hit additionally becomes a `mesh_interaction`
 * (`kind: "select"` / `"squeeze"`). No new event types or fields are introduced.
 *
 * Everything is read **structurally** (no hard import of `@babylonjs/core`'s WebXR
 * classes), mirroring {@link babylonCollector}. Babylon is left-handed — the same as
 * the canonical wire frame (ADR 0018) — so canonicalization is a copy; it is applied
 * anyway to keep the emission boundary uniform across connectors.
 */

/** Babylon column-major 4×4 matrix view (`TransformNode.getWorldMatrix().m`). */
interface BabylonMatrixLike {
  m: ArrayLike<number>;
}

/** Structural view of a Babylon `TransformNode` (the controller `pointer`). */
interface BabylonNodeLike {
  getWorldMatrix?(): BabylonMatrixLike;
  computeWorldMatrix?(force?: boolean): BabylonMatrixLike;
}

/** Structural view of a Babylon `Observable<T>` (only the bits we use). */
interface ObservableLike<T> {
  add(callback: (eventData: T) => void): unknown;
  remove(observer: unknown): boolean;
}

/** Structural view of a Babylon `WebXRControllerComponent` (trigger / squeeze). */
interface MotionControllerComponentLike {
  pressed?: boolean;
  onButtonStateChangedObservable?: ObservableLike<MotionControllerComponentLike>;
}

/** Structural view of a Babylon `WebXRAbstractMotionController`. */
interface MotionControllerLike {
  getComponentOfType?(type: string): MotionControllerComponentLike | null;
}

/** Structural view of a Babylon `WebXRInputSource`. */
interface BabylonXrControllerLike {
  inputSource?: XrInputSourceLike;
  pointer?: BabylonNodeLike;
  motionController?: MotionControllerLike | null;
  onMotionControllerInitObservable?: ObservableLike<MotionControllerLike>;
}

/** Structural view of a Babylon `WebXRInput` (`experience.input`). */
interface BabylonXrInputLike {
  controllers?: ArrayLike<BabylonXrControllerLike>;
  onControllerAddedObservable?: ObservableLike<BabylonXrControllerLike>;
  onControllerRemovedObservable?: ObservableLike<BabylonXrControllerLike>;
}

/**
 * Structural view of a Babylon `WebXRExperienceHelper` (`experience.baseExperience`).
 * Its `onStateChangedObservable` reports `WebXRState` transitions, letting us run the
 * pose timer only while the user is actually in an immersive session.
 */
interface WebXrExperienceHelperLike {
  /** Current `WebXRState` (`IN_XR === 2`). */
  state?: number;
  onStateChangedObservable?: ObservableLike<number>;
}

/**
 * Structural view of a Babylon `WebXRDefaultExperience` — the handle returned by
 * `scene.createDefaultXRExperienceAsync()`. Babylon, unlike three (which exposes XR
 * on the always-available `renderer.xr`), has no scene-global XR handle, so this
 * reference must be supplied. The `input` registry yields controllers; the optional
 * `baseExperience` state observable gates pose sampling on session entry/exit.
 */
export interface BabylonXrExperienceLike {
  input?: BabylonXrInputLike;
  baseExperience?: WebXrExperienceHelperLike;
}

export interface BabylonXrCollectorOptions {
  /** The Babylon WebXR experience whose controllers are read. */
  experience: BabylonXrExperienceLike;
  /** Controller pose sampling interval in ms. Default 250. */
  sampleMs?: number;
  /** Toggle individual XR capture channels. */
  capture?: XrCaptureOptions;
  /**
   * Resolve controller rays to scene hits (world point + object name). Optional —
   * without it, controller pose is still captured as `pointer_move` rays and select
   * still emits `pointer_click`; only `hitPoint`/`hitMesh` and `mesh_interaction`
   * need a probe.
   */
  raycast?: XrRayProbe;
}

// Babylon motion-controller component type ids (WebXRControllerComponent.*_TYPE).
const TRIGGER_TYPE = "trigger";
const SQUEEZE_TYPE = "squeeze";
// Babylon `WebXRState.IN_XR` — the user is in an active immersive session.
const WEBXR_STATE_IN_XR = 2;

/** A controller pose in Babylon's left-handed world frame. */
interface PoseLH {
  origin: Vec3;
  direction: Vec3;
}

/**
 * Read a controller's world-space ray from its pointer node's world matrix.
 * Babylon is **left-handed** and its controller pointer looks along local **+Z**, so
 * the world forward is the (normalized) third basis column; the origin is the
 * translation. Returns `undefined` when the matrix isn't available yet.
 */
function readPointerPose(node: BabylonNodeLike | undefined): PoseLH | undefined {
  const matrix = node?.getWorldMatrix?.() ?? node?.computeWorldMatrix?.(true);
  const e = matrix?.m;
  if (!e || e.length < 16) return undefined;
  const origin: Vec3 = [(e[12] as number) ?? 0, (e[13] as number) ?? 0, (e[14] as number) ?? 0];
  let fx = (e[8] as number) ?? 0;
  let fy = (e[9] as number) ?? 0;
  let fz = (e[10] as number) ?? 0;
  const len = Math.hypot(fx, fy, fz) || 1;
  fx /= len;
  fy /= len;
  fz /= len;
  return { origin, direction: [fx, fy, fz] };
}

/**
 * Create the Babylon WebXR controller collector as an sdk-core {@link Collector}.
 * Register it with `client.use(...)` alongside {@link babylonCollector} — `client
 * .stop()` then tears it down with everything else (timer + Babylon observers), so
 * there is no separate dispose path (ADR 0003).
 *
 * It hooks every controller currently in `experience.input` plus any added later
 * (`onControllerAddedObservable`), samples pose on a timer, and detects rising-edge
 * presses on each controller's trigger / squeeze component. When the experience
 * exposes `baseExperience.onStateChangedObservable`, the pose timer runs **only**
 * while the session is `IN_XR` (so booting on desktop and entering XR later is
 * captured automatically, with no timer until then); otherwise it falls back to an
 * always-on timer that simply no-ops while `input.controllers` is empty.
 */
export function babylonXrCollector(options: BabylonXrCollectorOptions): Collector {
  const { experience, sampleMs = 250, capture = {}, raycast } = options;
  const wantPointerMove = capture.pointerMove ?? true;
  const wantClicks = capture.clicks ?? true;
  const wantMeshPicks = capture.meshPicks ?? true;

  return {
    name: "babylon-xr",
    start(ctx: CollectorContext): CollectorHandle {
      const input = experience.input;
      let timer: ReturnType<typeof setInterval> | undefined;

      // Cleanup closures: top-level (input registry) subscriptions, plus per-
      // controller component subscriptions removed when a controller leaves.
      const subs: Array<() => void> = [];
      const controllerSubs = new Map<BabylonXrControllerLike, Array<() => void>>();

      const addSub = <T>(obs: ObservableLike<T> | undefined, cb: (event: T) => void) => {
        if (!obs || typeof obs.add !== "function") return;
        const observer = obs.add(cb);
        subs.push(() => {
          obs.remove(observer);
        });
      };
      const pushControllerCleanup = (controller: BabylonXrControllerLike, fn: () => void) => {
        const list = controllerSubs.get(controller) ?? [];
        list.push(fn);
        controllerSubs.set(controller, list);
      };

      // --- Continuous pose sampling → pointer_move (ray) -------------------------
      const sample = () => {
        const controllers = input?.controllers;
        if (!controllers) return;
        for (let i = 0; i < controllers.length; i++) {
          const controller = controllers[i];
          if (!controller) continue;
          const pose = readPointerPose(controller.pointer);
          if (!pose) continue;
          const src = controller.inputSource;
          const source = src ? xrSource(src) : "xr-controller";
          const handed = src ? xrHandedness(src) : undefined;
          const hit = raycast ? raycast(pose.origin, pose.direction) : undefined;
          ctx.emit({
            type: "pointer_move",
            // Ray sources carry no 2D `screen` position (ADR 0011).
            source,
            ...(handed ? { handedness: handed, sourceId: handed } : {}),
            ray: {
              origin: toCanonicalPosition(pose.origin, "left"),
              direction: toCanonicalDirection(pose.direction, "left"),
            },
            ...(hit ? { hitPoint: toCanonicalPosition(hit.point, "left") } : {}),
            ...(hit && hit.name ? { hitMesh: hit.name } : {}),
          });
        }
      };

      // --- Discrete actions → pointer_click + mesh_interaction -------------------
      const emitAction = (controller: BabylonXrControllerLike, kind: "select" | "squeeze") => {
        const pose = readPointerPose(controller.pointer);
        if (!pose) return;
        const src = controller.inputSource;
        const source = src ? xrSource(src) : "xr-controller";
        const handed = src ? xrHandedness(src) : undefined;
        const ray = {
          origin: toCanonicalPosition(pose.origin, "left"),
          direction: toCanonicalDirection(pose.direction, "left"),
        };
        const hit = raycast ? raycast(pose.origin, pose.direction) : undefined;
        const hitPoint = hit ? toCanonicalPosition(hit.point, "left") : undefined;
        const hitMesh = hit && hit.name ? hit.name : undefined;

        // The trigger ("select") is the XR analogue of a click.
        if (kind === "select" && wantClicks) {
          ctx.emit({
            type: "pointer_click",
            source,
            ...(handed ? { handedness: handed, sourceId: handed } : {}),
            ray,
            ...(hitPoint ? { hitPoint } : {}),
            ...(hitMesh ? { hitMesh } : {}),
          });
        }
        // A named hit becomes a source-neutral mesh interaction (ADR 0011).
        if (wantMeshPicks && hitMesh) {
          ctx.emit({
            type: "mesh_interaction",
            mesh: hitMesh,
            kind,
            ...(hitPoint ? { point: hitPoint } : {}),
            source,
            ...(handed ? { handedness: handed } : {}),
          });
        }
      };

      // --- Component / controller wiring ----------------------------------------
      const hookComponent = (
        controller: BabylonXrControllerLike,
        motionController: MotionControllerLike,
        type: string,
        kind: "select" | "squeeze",
      ) => {
        const component = motionController.getComponentOfType?.(type) ?? null;
        const obs = component?.onButtonStateChangedObservable;
        if (!component || !obs || typeof obs.add !== "function") return;
        let wasPressed = component.pressed ?? false;
        const observer = obs.add((changed) => {
          const pressed = changed.pressed ?? false;
          if (pressed && !wasPressed) emitAction(controller, kind);
          wasPressed = pressed;
        });
        pushControllerCleanup(controller, () => {
          obs.remove(observer);
        });
      };

      const hookMotionController = (
        controller: BabylonXrControllerLike,
        motionController: MotionControllerLike,
      ) => {
        if (!wantClicks && !wantMeshPicks) return;
        hookComponent(controller, motionController, TRIGGER_TYPE, "select");
        hookComponent(controller, motionController, SQUEEZE_TYPE, "squeeze");
      };

      const hookController = (controller: BabylonXrControllerLike) => {
        if (controller.motionController) {
          hookMotionController(controller, controller.motionController);
        }
        const obs = controller.onMotionControllerInitObservable;
        if (obs && typeof obs.add === "function") {
          const observer = obs.add((motionController) => {
            hookMotionController(controller, motionController);
          });
          pushControllerCleanup(controller, () => {
            obs.remove(observer);
          });
        }
      };

      const unhookController = (controller: BabylonXrControllerLike) => {
        const list = controllerSubs.get(controller);
        if (!list) return;
        for (const fn of list) fn();
        controllerSubs.delete(controller);
      };

      // Hook controllers present now, and track add/remove for the rest.
      const existing = input?.controllers;
      if (existing) {
        for (let i = 0; i < existing.length; i++) {
          const controller = existing[i];
          if (controller) hookController(controller);
        }
      }
      addSub(input?.onControllerAddedObservable, (controller) => hookController(controller));
      addSub(input?.onControllerRemovedObservable, (controller) => unhookController(controller));

      const startTimer = () => {
        if (!wantPointerMove || timer !== undefined) return;
        timer = setInterval(sample, sampleMs);
      };
      const stopTimer = () => {
        if (timer === undefined) return;
        clearInterval(timer);
        timer = undefined;
      };

      // Prefer Babylon's XR state observable: sample pose only while the user is in
      // an immersive session (WebXRState.IN_XR), and auto-start when they enter XR
      // later. Fall back to an always-on timer when no base experience is provided.
      const helper = experience.baseExperience;
      const stateObs = helper?.onStateChangedObservable;
      if (stateObs && typeof stateObs.add === "function") {
        if (helper?.state === WEBXR_STATE_IN_XR) startTimer();
        addSub(stateObs, (state) => {
          if (state === WEBXR_STATE_IN_XR) startTimer();
          else stopTimer();
        });
      } else {
        startTimer();
      }

      return {
        stop() {
          stopTimer();
          for (const fn of subs) fn();
          subs.length = 0;
          for (const [, list] of controllerSubs) for (const fn of list) fn();
          controllerSubs.clear();
        },
      };
    },
  };
}
