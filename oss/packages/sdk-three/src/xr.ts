import type { Collector, CollectorContext, CollectorHandle } from "@uptimizr/sdk-core";
import {
  toCanonicalDirection,
  toCanonicalPosition,
  xrHandedness,
  xrSource,
} from "@uptimizr/sdk-core";
import type { XrCaptureOptions, XrInputSourceLike, XrRayProbe } from "@uptimizr/sdk-core";
import type { Vec3 } from "@uptimizr/schema";

// Re-export the shared XR option/probe shapes so consumers (and `@uptimizr/aframe`,
// `@uptimizr/r3f`) can import them from the three connector surface.
export type { XrCaptureOptions, XrRayHit, XrRayProbe } from "@uptimizr/sdk-core";

/**
 * WebXR controller / gaze capture for the three.js connector.
 *
 * In an immersive session the headset becomes the active camera, so camera/gaze
 * **pose** keeps flowing through the regular {@link threeCollector} passively. The
 * gap this collector fills is **controller input**, which never arrives as DOM
 * pointer events: it reads three's `WebXRManager` (`renderer.xr`) and maps live XR
 * input sources onto the existing source-neutral schema events (ADR 0011).
 * Controller and gaze **pose** become `pointer_move` events carrying a world-space
 * `ray` (+ `source` / `handedness`); a controller **select** (the XR trigger)
 * becomes a `pointer_click`, and a named hit additionally becomes a
 * `mesh_interaction` (`kind: "select"` / `"squeeze"`). No new event types or fields
 * are introduced — everything is imported from `@uptimizr/schema`.
 *
 * Everything is read **structurally** (no hard import of three's XR internals), via
 * `renderer.xr`. World-space data is normalized from three's right-handed frame to
 * the canonical wire frame at the emission boundary, exactly like
 * {@link threeCollector} (ADR 0018). It is shared verbatim by `@uptimizr/aframe`
 * (A-Frame renders three) and is available to `@uptimizr/r3f`.
 */

/** Column-major 4×4 matrix view (`controller.matrixWorld`). */
interface Mat4Like {
  elements: ArrayLike<number>;
}

/** Structural view of a three XR target-ray controller (`xr.getController(i)`). */
interface XrControllerLike {
  matrixWorld?: Mat4Like;
}

/** Structural view of a WebXR `XRInputSourceEvent` (`select` / `squeeze`). */
interface XrInputSourceEventLike {
  inputSource?: XrInputSourceLike;
}

/** Structural view of a WebXR `XRSession`. */
interface XrSessionLike {
  inputSources?: ArrayLike<XrInputSourceLike>;
  addEventListener?(type: string, handler: (event: XrInputSourceEventLike) => void): void;
  removeEventListener?(type: string, handler: (event: XrInputSourceEventLike) => void): void;
}

/** Structural view of three's `WebXRManager` (`renderer.xr`). */
interface WebXrManagerLike {
  isPresenting?: boolean;
  getSession?(): XrSessionLike | null | undefined;
  getController?(index: number): XrControllerLike | undefined;
  addEventListener?(type: string, handler: (event: unknown) => void): void;
  removeEventListener?(type: string, handler: (event: unknown) => void): void;
}

/** The renderer surface this collector reads — just the XR manager. */
export interface XrRendererLike {
  xr?: WebXrManagerLike;
}

export interface XrCollectorOptions {
  /** The three.js renderer driving the scene; its `.xr` manager is read. */
  renderer: XrRendererLike;
  /** Controller/gaze pose sampling interval in ms. Default 250. */
  sampleMs?: number;
  /** Toggle individual XR capture channels. */
  capture?: XrCaptureOptions;
  /**
   * Resolve controller rays to scene hits (world point + object name). Optional —
   * without it, controller/gaze pose is still captured as `pointer_move` rays, and
   * select still emits `pointer_click`; only `hitPoint`/`hitMesh` and
   * `mesh_interaction` need a probe.
   */
  raycast?: XrRayProbe;
}

/** A controller pose in three's right-handed world frame. */
interface PoseRH {
  origin: Vec3;
  direction: Vec3;
}

/**
 * Read a controller's world-space ray from its `matrixWorld`. three's XR
 * target-ray space looks along local **−Z** (like its cameras), so the world
 * forward is the negated third basis column; the origin is the translation.
 * Returns `undefined` when the matrix isn't available yet.
 */
function readControllerPose(controller: XrControllerLike | undefined): PoseRH | undefined {
  const e = controller?.matrixWorld?.elements;
  if (!e || e.length < 16) return undefined;
  const origin: Vec3 = [(e[12] as number) ?? 0, (e[13] as number) ?? 0, (e[14] as number) ?? 0];
  let fx = -((e[8] as number) ?? 0);
  let fy = -((e[9] as number) ?? 0);
  let fz = -((e[10] as number) ?? 0);
  const len = Math.hypot(fx, fy, fz) || 1;
  fx /= len;
  fy /= len;
  fz /= len;
  return { origin, direction: [fx, fy, fz] };
}

/**
 * Create the WebXR controller/gaze collector as an sdk-core {@link Collector}.
 * Register it with `client.use(...)` alongside the three connector — `client.stop()`
 * then tears it down with everything else (timers + XR listeners), so there is no
 * separate dispose path (ADR 0003).
 *
 * It attaches to the active `XRSession` when an immersive session starts (and
 * immediately if one is already presenting), samples controller/gaze pose on a
 * timer, and listens for `select` / `squeeze`. On `sessionend` it detaches; on
 * `stop()` it removes every listener and clears the timer.
 */
export function xrCollector(options: XrCollectorOptions): Collector {
  const { renderer, sampleMs = 250, capture = {}, raycast } = options;
  const wantPointerMove = capture.pointerMove ?? true;
  const wantClicks = capture.clicks ?? true;
  const wantMeshPicks = capture.meshPicks ?? true;

  return {
    name: "three-xr",
    start(ctx: CollectorContext): CollectorHandle {
      const xr = renderer.xr;
      let timer: ReturnType<typeof setInterval> | undefined;
      let activeSession: XrSessionLike | undefined;
      let onSelect: ((event: XrInputSourceEventLike) => void) | undefined;
      let onSqueeze: ((event: XrInputSourceEventLike) => void) | undefined;

      const indexOfInputSource = (session: XrSessionLike, input: XrInputSourceLike): number => {
        const sources = session.inputSources;
        if (!sources) return -1;
        for (let i = 0; i < sources.length; i++) if (sources[i] === input) return i;
        return -1;
      };

      const readPose = (index: number): PoseRH | undefined => {
        if (index < 0 || typeof xr?.getController !== "function") return undefined;
        return readControllerPose(xr.getController(index));
      };

      // --- Continuous pose sampling → pointer_move (ray) -------------------------
      const sample = () => {
        const session = activeSession;
        if (!session) return;
        const sources = session.inputSources;
        if (!sources) return;
        for (let i = 0; i < sources.length; i++) {
          const input = sources[i];
          if (!input) continue;
          const pose = readPose(i);
          if (!pose) continue;
          const source = xrSource(input);
          const handed = xrHandedness(input);
          const hit = raycast ? raycast(pose.origin, pose.direction) : undefined;
          ctx.emit({
            type: "pointer_move",
            // Ray sources carry no 2D `screen` position (ADR 0011).
            source,
            ...(handed ? { handedness: handed, sourceId: handed } : {}),
            ray: {
              origin: toCanonicalPosition(pose.origin, "right"),
              direction: toCanonicalDirection(pose.direction, "right"),
            },
            ...(hit ? { hitPoint: toCanonicalPosition(hit.point, "right") } : {}),
            ...(hit && hit.name ? { hitMesh: hit.name } : {}),
          });
        }
      };

      // --- Discrete actions → pointer_click + mesh_interaction -------------------
      const emitAction = (input: XrInputSourceLike, kind: "select" | "squeeze") => {
        const session = activeSession;
        if (!session) return;
        const pose = readPose(indexOfInputSource(session, input));
        if (!pose) return;
        const source = xrSource(input);
        const handed = xrHandedness(input);
        const ray = {
          origin: toCanonicalPosition(pose.origin, "right"),
          direction: toCanonicalDirection(pose.direction, "right"),
        };
        const hit = raycast ? raycast(pose.origin, pose.direction) : undefined;
        const hitPoint = hit ? toCanonicalPosition(hit.point, "right") : undefined;
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

      const attachSession = (session: XrSessionLike | null | undefined) => {
        if (!session || session === activeSession) return;
        activeSession = session;
        if (typeof session.addEventListener === "function") {
          onSelect = (event) => {
            if (event.inputSource) emitAction(event.inputSource, "select");
          };
          onSqueeze = (event) => {
            if (event.inputSource) emitAction(event.inputSource, "squeeze");
          };
          session.addEventListener("select", onSelect);
          session.addEventListener("squeeze", onSqueeze);
        }
        if (timer === undefined && wantPointerMove) {
          timer = setInterval(sample, sampleMs);
        }
      };

      const detachSession = () => {
        const session = activeSession;
        if (session && typeof session.removeEventListener === "function") {
          if (onSelect) session.removeEventListener("select", onSelect);
          if (onSqueeze) session.removeEventListener("squeeze", onSqueeze);
        }
        onSelect = undefined;
        onSqueeze = undefined;
        activeSession = undefined;
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };

      const onSessionStart = () => attachSession(xr?.getSession?.());
      const onSessionEnd = () => detachSession();

      if (xr && typeof xr.addEventListener === "function") {
        xr.addEventListener("sessionstart", onSessionStart);
        xr.addEventListener("sessionend", onSessionEnd);
      }
      // A session may already be presenting when capture starts.
      if (xr?.isPresenting) attachSession(xr.getSession?.());

      return {
        stop() {
          detachSession();
          if (xr && typeof xr.removeEventListener === "function") {
            xr.removeEventListener("sessionstart", onSessionStart);
            xr.removeEventListener("sessionend", onSessionEnd);
          }
        },
      };
    },
  };
}
