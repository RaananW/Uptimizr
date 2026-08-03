import type { Collector, CollectorContext, CollectorHandle } from "@uptimizr/sdk-core";
import { toCanonicalPosition } from "@uptimizr/sdk-core";
import type { Vec3 } from "@uptimizr/schema";

/**
 * WebXR guardian/boundary-proximity capture for the Babylon.js connector
 * (#157, ADR 0048).
 *
 * Room-scale VR runtimes let the visitor define a play-space **boundary**
 * (Meta's Guardian, SteamVR Chaperone, …). Repeatedly backing into that boundary
 * mid-session is a strong physical-discomfort / space-too-small signal that game
 * studios cannot see today. This collector detects those approaches **entirely
 * on device** and emits one `xr_boundary_proximity` event per approach carrying
 * only the coarse HMD position at closest approach plus how long the headset
 * lingered in the near-boundary zone.
 *
 * CRITICAL privacy stance (ADR 0003 / ADR 0048): the boundary polygon and room
 * geometry are **never** transmitted. The bounds-check runs here; the only thing
 * that leaves the device is the outcome — a voxel-bin-friendly position + a
 * duration — exactly like every other coarse world-space signal. No opt-in flag
 * is needed because nothing new about the physical space is captured.
 *
 * Everything is read **structurally** (no hard import of `@babylonjs/core`'s
 * WebXR classes or the WebXR DOM lib), mirroring {@link babylonXrCollector}: it
 * reads `experience.baseExperience.sessionManager` for the current reference
 * space and per-frame viewer pose. When the session's reference space is a
 * *bounded-floor* space it exposes `boundsGeometry` (a floor-plane polygon); the
 * collector no-ops for any other space (e.g. `local-floor`), so a scene without a
 * configured boundary simply produces nothing.
 */

/** Structural view of a Babylon `Observable<T>` (only the bits we use). */
interface ObservableLike<T> {
  add(callback: (eventData: T) => void): unknown;
  remove(observer: unknown): boolean;
}

/** Structural view of a WebXR `DOMPointReadOnly` (position / boundary vertex). */
interface XrPointLike {
  x: number;
  y: number;
  z: number;
}

/** Structural view of a WebXR `XRRigidTransform`. */
interface XrRigidTransformLike {
  position?: XrPointLike;
}

/** Structural view of a WebXR `XRViewerPose`. */
interface XrViewerPoseLike {
  transform?: XrRigidTransformLike;
}

/** Structural view of a WebXR `XRFrame` (only `getViewerPose`). */
interface XrFrameLike {
  getViewerPose?(referenceSpace: unknown): XrViewerPoseLike | null | undefined;
}

/**
 * Structural view of a WebXR `XRReferenceSpace`. A *bounded-floor* space also
 * carries `boundsGeometry` — the play-space polygon in the floor (X/Z) plane.
 * Its presence is how we tell a bounded space apart from `local-floor`.
 */
interface XrReferenceSpaceLike {
  boundsGeometry?: ArrayLike<XrPointLike>;
}

/**
 * Structural view of a Babylon `WebXRSessionManager`
 * (`experience.baseExperience.sessionManager`): the current reference space plus
 * the per-frame observable that drives the on-device bounds-check.
 */
interface WebXrSessionManagerLike {
  referenceSpace?: XrReferenceSpaceLike;
  onXRFrameObservable?: ObservableLike<XrFrameLike>;
}

/** Structural view of a Babylon `WebXRExperienceHelper` (`experience.baseExperience`). */
interface WebXrExperienceHelperLike {
  sessionManager?: WebXrSessionManagerLike;
}

/**
 * Structural view of a Babylon `WebXRDefaultExperience` — the handle returned by
 * `scene.createDefaultXRExperienceAsync()`. Only `baseExperience.sessionManager`
 * is needed here (the reference space + frame observable).
 */
export interface BabylonXrBoundaryExperienceLike {
  baseExperience?: WebXrExperienceHelperLike;
}

/**
 * Recommended default "near boundary" threshold, in metres. 0.5 m (50 cm) marks
 * the point where a visitor is clearly crowding their guardian — close enough to
 * be a real comfort signal, far enough to ignore incidental lean-throughs. Tune
 * per experience via {@link BabylonBoundaryCollectorOptions.nearMeters}.
 */
export const DEFAULT_NEAR_METERS = 0.5;

/** Default exit hysteresis (metres) added to the near threshold to avoid flapping. */
export const DEFAULT_HYSTERESIS_METERS = 0.1;

/** Default on-device bounds-check cadence (ms). ~10 Hz is ample for a comfort signal. */
export const DEFAULT_SAMPLE_MS = 100;

export interface BabylonBoundaryCollectorOptions {
  /** The Babylon WebXR experience whose session manager is read. */
  experience: BabylonXrBoundaryExperienceLike;
  /**
   * Distance (metres) from the guardian boundary that counts as "near". An
   * approach begins when the HMD comes within this distance of the nearest
   * boundary edge. Default {@link DEFAULT_NEAR_METERS} (0.5 m).
   */
  nearMeters?: number;
  /**
   * Extra distance (metres) beyond {@link nearMeters} the HMD must retreat before
   * the approach is considered over — hysteresis that stops a pose hovering right
   * at the threshold from emitting a burst of events. Default 0.1 m.
   */
  hysteresisMeters?: number;
  /** On-device bounds-check cadence in ms. Default {@link DEFAULT_SAMPLE_MS} (100). */
  sampleMs?: number;
}

/** 2D (floor-plane) distance from point `(px,pz)` to segment `a→b`. */
function distanceToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

/**
 * Shortest floor-plane distance from `(px,pz)` to the boundary polygon (a closed
 * loop of `bounds`). Returns `Infinity` when there is no usable boundary (fewer
 * than two vertices), so the caller simply never triggers.
 */
export function distanceToBoundary(px: number, pz: number, bounds: ArrayLike<XrPointLike>): number {
  const n = bounds.length;
  if (n < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const a = bounds[i]!;
    const b = bounds[(i + 1) % n]!;
    const d = distanceToSegment(px, pz, a.x, a.z, b.x, b.z);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Create the Babylon WebXR guardian/boundary-proximity collector as an sdk-core
 * {@link Collector}. Register it with `client.use(...)` alongside
 * {@link babylonCollector} — `client.stop()` then tears it down (frame observer +
 * a final flush of any in-progress approach), so there is no separate dispose
 * path (ADR 0003).
 *
 * Each XR frame (throttled to {@link BabylonBoundaryCollectorOptions.sampleMs}) it
 * reads the viewer pose in the session's reference space and, when that space is a
 * bounded-floor space, measures the floor-plane distance to the nearest boundary
 * edge. Crossing **into** the near zone (`≤ nearMeters`) opens an approach;
 * retreating past `nearMeters + hysteresisMeters` (or the session ending) closes
 * it and emits a single `xr_boundary_proximity` with the HMD position at closest
 * approach and the time spent in the zone. The boundary polygon itself never
 * leaves the device.
 */
export function babylonBoundaryCollector(options: BabylonBoundaryCollectorOptions): Collector {
  const {
    experience,
    nearMeters = DEFAULT_NEAR_METERS,
    hysteresisMeters = DEFAULT_HYSTERESIS_METERS,
    sampleMs = DEFAULT_SAMPLE_MS,
  } = options;
  const exitMeters = nearMeters + Math.max(0, hysteresisMeters);

  return {
    name: "babylon-boundary",
    start(ctx: CollectorContext): CollectorHandle {
      const manager = experience.baseExperience?.sessionManager;
      const frameObs = manager?.onXRFrameObservable;

      // In-progress approach state (null when the HMD is outside the near zone).
      let enterMs: number | null = null;
      let closestDistance = Infinity;
      let closestPos: Vec3 | null = null;
      let lastSampleMs = -Infinity;

      const flush = () => {
        if (enterMs === null || !closestPos) return;
        ctx.emit({
          type: "xr_boundary_proximity",
          // Coarse HMD position at closest approach (voxel-binned downstream, ADR
          // 0010). Babylon is left-handed — same as the canonical wire frame.
          position: toCanonicalPosition(closestPos, "left"),
          durationMs: Math.max(0, ctx.now() - enterMs),
        });
        enterMs = null;
        closestDistance = Infinity;
        closestPos = null;
      };

      const onFrame = (frame: XrFrameLike) => {
        const now = ctx.now();
        if (now - lastSampleMs < sampleMs) return;
        lastSampleMs = now;

        const refSpace = manager?.referenceSpace;
        const bounds = refSpace?.boundsGeometry;
        // No bounded-floor boundary configured → nothing to measure. If we were
        // mid-approach (e.g. the runtime dropped the boundary), close it out.
        if (!refSpace || !bounds || bounds.length < 2) {
          flush();
          return;
        }
        const pos = frame.getViewerPose?.(refSpace)?.transform?.position;
        if (!pos) return;

        const distance = distanceToBoundary(pos.x, pos.z, bounds);
        if (distance <= nearMeters) {
          const worldPos: Vec3 = [pos.x, pos.y, pos.z];
          if (enterMs === null) {
            enterMs = now;
            closestDistance = distance;
            closestPos = worldPos;
          } else if (distance < closestDistance) {
            closestDistance = distance;
            closestPos = worldPos;
          }
        } else if (enterMs !== null && distance > exitMeters) {
          flush();
        }
      };

      let observer: unknown;
      if (frameObs && typeof frameObs.add === "function") {
        observer = frameObs.add(onFrame);
      }

      return {
        stop() {
          if (frameObs && observer !== undefined) frameObs.remove(observer);
          // A visitor lingering in the zone when the session ends is still an
          // approach — emit it rather than dropping the outcome.
          flush();
        },
      };
    },
  };
}
