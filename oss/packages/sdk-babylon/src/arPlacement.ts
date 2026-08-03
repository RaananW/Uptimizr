import type { Collector, CollectorContext, CollectorHandle } from "@uptimizr/sdk-core";
import { toCanonicalPosition } from "@uptimizr/sdk-core";
import type { ArPlacementSurface, Vec3 } from "@uptimizr/schema";

/**
 * WebXR AR object-placement capture for the Babylon.js connector (#156, ADR 0048).
 *
 * Retail "view in your room" AR is app-driven: only the application knows when the
 * visitor enters placement mode, taps to (re-)place the model, and finally commits
 * it. This collector turns those three semantic moments — surfaced as Babylon
 * `Observable`s the app already owns — into exactly **one** `ar_placement` event per
 * settle (never per frame, ADR 0048 §1). It counts re-placement `attempts`, measures
 * `timeToPlaceMs` from placement-mode entry to settle, records the final world
 * `position` and `scale`, and classifies the `surface` coarsely from the WebXR
 * hit-test / plane normal.
 *
 * Everything is read **structurally** (no hard `@babylonjs/core` import), mirroring
 * {@link babylonXrCollector}, and every observer is torn down on `stop()` so there is
 * no leak (ADR 0003). Signals are coarse and on-device only: no plane polygons, no
 * room dimensions, no PII — only the coarse surface bucket and counts/durations leave
 * the client. World position is voxel-binned downstream like every spatial signal.
 */

/** Structural view of a Babylon `Observable<T>` (only the bits we use). */
interface ObservableLike<T> {
  add(callback: (eventData: T) => void): unknown;
  remove(observer: unknown): boolean;
}

/** A Babylon `Vector3` (structural) or a plain canonical `[x, y, z]` tuple. */
type Vector3Like = { x: number; y: number; z: number } | Vec3;

function toTuple(v: Vector3Like | undefined): Vec3 | undefined {
  if (!v) return undefined;
  if (Array.isArray(v)) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
}

/**
 * Classify a real-world surface into ADR 0048's coarse bucket from its (world)
 * normal and, optionally, the placement height in metres. Pure and on-device:
 * derived only from the hit-test plane orientation, never from raw geometry.
 *
 * - up-facing normal (`ny ≥ 0.7`): `table` when the hit sits at roughly desk
 *   height (0.35–1.3 m), otherwise `floor`.
 * - down-facing normal (`ny ≤ -0.7`): `ceiling`.
 * - near-horizontal normal (`|ny| ≤ 0.4`): `wall`.
 * - anything in between: `unknown`.
 */
export function classifyArSurface(
  normal: Vector3Like | undefined,
  height?: number,
): ArPlacementSurface {
  const n = toTuple(normal);
  if (!n) return "unknown";
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const ny = n[1] / len;
  if (ny >= 0.7) {
    if (height !== undefined && height >= 0.35 && height <= 1.3) return "table";
    return "floor";
  }
  if (ny <= -0.7) return "ceiling";
  if (Math.abs(ny) <= 0.4) return "wall";
  return "unknown";
}

/** Fired when the visitor enters placement mode for a model (e.g. taps "view in your room"). */
export interface ArPlacementStart {
  /** Name of the model/asset being placed (becomes the `ar_placement.mesh`). */
  mesh: string;
}

/** A single place / re-place action: where the model currently sits and on what. */
export interface ArPlaceCandidate {
  /** Current world position of the model (Babylon left-handed, or a canonical tuple). */
  position?: Vector3Like;
  /** Surface normal at the hit, used to classify the surface when `surface` is absent. */
  normal?: Vector3Like;
  /** Explicit coarse surface, overriding normal-based classification. */
  surface?: ArPlacementSurface;
}

/** The placement settle: the final committed pose, scale, and whether it's the last one. */
export interface ArPlacementSettleInput extends ArPlaceCandidate {
  /** Overrides the model name captured at `start` (rarely needed). */
  mesh?: string;
  /** Final scale relative to the model's authored real-world size (`1` = actual size). */
  scale?: number;
  /** Whether this is the last placement recorded for the session (default `false`). */
  final?: boolean;
}

/** Structural view of a Babylon `WebXRHitTest` feature (`onHitTestResultObservable`). */
export interface ArHitTestLike {
  onHitTestResultObservable?: ObservableLike<ArHitResultLike[]>;
}

/** Structural view of a single `IWebXRHitResult` (position + optional normal). */
export interface ArHitResultLike {
  position?: Vector3Like;
  normal?: Vector3Like;
}

export interface BabylonArPlacementOptions {
  /** Fires when the visitor enters placement mode for a model. Resets the attempt/timer state. */
  onPlacementStartObservable?: ObservableLike<ArPlacementStart>;
  /** Fires on each place / re-place action; each fire counts as one `attempt`. */
  onPlaceObservable?: ObservableLike<ArPlaceCandidate>;
  /** Fires when the placement settles/commits; emits the `ar_placement` event. */
  onSettleObservable: ObservableLike<ArPlacementSettleInput>;
  /**
   * Optional WebXR hit-test feature. Its results continuously refine the current
   * surface classification, so a `place`/`settle` that omits a `normal` still lands
   * on a sensible coarse `surface`.
   */
  hitTest?: ArHitTestLike;
  /** Default model name when a `start`/`settle` doesn't carry one. */
  mesh?: string;
}

/** Mutable state for the placement currently being tracked. */
interface ActivePlacement {
  mesh: string;
  startedAtMs: number;
  attempts: number;
  candidate?: { position?: Vec3; surface?: ArPlacementSurface };
}

/**
 * Create the Babylon WebXR AR-placement collector as an sdk-core {@link Collector}.
 * Register it with `client.use(...)` alongside {@link babylonCollector}; `client
 * .stop()` then tears it down with everything else (all Babylon observers), so there
 * is no separate dispose path (ADR 0003).
 *
 * Wire the three placement observables from your AR UI (enter placement mode →
 * `onPlacementStartObservable`, each tap that (re-)places the model →
 * `onPlaceObservable`, the confirm/commit → `onSettleObservable`). Supplying the
 * WebXR `hitTest` feature lets the collector classify the surface for you.
 */
export function babylonArPlacementCollector(options: BabylonArPlacementOptions): Collector {
  const { onPlacementStartObservable, onPlaceObservable, onSettleObservable, hitTest } = options;
  const defaultMesh = options.mesh ?? "ar-model";

  return {
    name: "babylon-ar-placement",
    start(ctx: CollectorContext): CollectorHandle {
      const subs: Array<() => void> = [];
      const addSub = <T>(obs: ObservableLike<T> | undefined, cb: (event: T) => void) => {
        if (!obs || typeof obs.add !== "function") return;
        const observer = obs.add(cb);
        subs.push(() => {
          obs.remove(observer);
        });
      };

      // The latest hit-test surface classification, used when a place/settle omits
      // its own normal. Position is left to the place/settle payloads.
      let hoverSurface: ArPlacementSurface | undefined;
      let active: ActivePlacement | undefined;

      const beginPlacement = (mesh: string) => {
        active = { mesh, startedAtMs: ctx.now(), attempts: 0, candidate: undefined };
      };

      const applyCandidate = (c: ArPlaceCandidate) => {
        const position = toTuple(c.position);
        const surface =
          c.surface ?? (c.normal ? classifyArSurface(c.normal, position?.[1]) : hoverSurface);
        const prev = active?.candidate;
        return {
          position: position ?? prev?.position,
          surface: surface ?? prev?.surface,
        };
      };

      addSub(onPlacementStartObservable, (e) => beginPlacement(e?.mesh ?? defaultMesh));

      addSub(onPlaceObservable, (c) => {
        // A place before any explicit start implies entering placement mode now.
        if (!active) beginPlacement(defaultMesh);
        active!.attempts += 1;
        active!.candidate = applyCandidate(c ?? {});
      });

      addSub(hitTest?.onHitTestResultObservable, (results) => {
        const first = results?.[0];
        if (!first) return;
        const position = toTuple(first.position);
        hoverSurface = classifyArSurface(first.normal, position?.[1]);
      });

      addSub(onSettleObservable, (s) => {
        const input = s ?? ({} as ArPlacementSettleInput);
        if (!active) beginPlacement(input.mesh ?? defaultMesh);
        const candidate = applyCandidate(input);
        // A settle with no prior place still represents a single placement action.
        const attempts = Math.max(1, active!.attempts);
        const position = candidate.position ?? [0, 0, 0];
        const surface = candidate.surface ?? "unknown";
        const timeToPlaceMs = Math.max(0, ctx.now() - active!.startedAtMs);
        const scale = input.scale !== undefined && input.scale > 0 ? input.scale : 1;
        ctx.emit({
          type: "ar_placement",
          mesh: input.mesh ?? active!.mesh,
          position: toCanonicalPosition(position, "left"),
          surface,
          attempts,
          timeToPlaceMs,
          scale,
          final: input.final ?? false,
        });
        // Clear the tracked placement; a fresh start (or place) begins the next one.
        active = undefined;
      });

      return {
        stop() {
          for (const fn of subs) fn();
          subs.length = 0;
          active = undefined;
        },
      };
    },
  };
}
