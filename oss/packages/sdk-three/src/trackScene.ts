import { UptimizrClient } from "@uptimizr/sdk-core";
import type { StartMeta, Transport, SamplingProfile } from "@uptimizr/sdk-core";
import type { CameraKind, SessionUser } from "@uptimizr/schema";
import type { Camera, Scene, WebGLRenderer } from "three";

import { threeCollector } from "./collector.js";
import type { ThreeActor, ThreeCaptureOptions, ThreeGazeOptions } from "./collector.js";
import { xrCollector } from "./xr.js";
import type { XrRendererLike } from "./xr.js";
import { readDeviceCaps } from "./device.js";
import { readGraphics } from "./graphics.js";
import { readConnector } from "./connector.js";
import { readSceneMeta } from "./scene.js";
import type { XrCaptureOptions, XrRayProbe } from "@uptimizr/sdk-core";

/**
 * Options for {@link trackScene} — the project/endpoint plus the same sampling and
 * capture knobs as {@link threeCollector}, flattened for one-call setup.
 */
export interface TrackSceneOptions {
  /** Project identifier (public, non-secret). */
  projectId: string;
  /** Collector endpoint base URL, e.g. `https://collect.example.com`. */
  endpoint: string;
  /** Camera-pose sampling interval in ms. Default 1000. */
  sampleCameraMs?: number;
  /** Performance (FPS) sampling interval in ms. Default 2000. */
  samplePerfMs?: number;
  /** Minimum gap between `pointer_move` samples in ms. Default 250. */
  pointerMoveThrottleMs?: number;
  /**
   * Per-channel capture-fidelity dial in Hz / `"frame"` / `0`-off (ADR 0012),
   * e.g. `{ camera: 10, pointerMove: 60, perf: 0.5 }`. Governs continuous channels
   * only; discrete events (clicks, picks, ...) are always captured. Overrides the
   * matching legacy ms knob; omitted channels keep the conservative defaults.
   */
  sampling?: SamplingProfile;
  /** Skip timer-based camera samples while the pose is unchanged. Default true. */
  suppressIdleSamples?: boolean;
  /**
   * Dedupe `frame_perf` samples while FPS is steady (within {@link perfFpsThreshold}).
   * Default false — a steady FPS is meaningful telemetry, so perf reports continuously.
   */
  suppressIdlePerfSamples?: boolean;
  /** Max per-axis pose change treated as "unchanged" for camera dedupe. Default 1e-3. */
  cameraEpsilon?: number;
  /** Max FPS change treated as "unchanged" for perf dedupe. Default 1. */
  perfFpsThreshold?: number;
  /** Toggle individual capture channels. */
  capture?: ThreeCaptureOptions;
  /**
   * World-space gaze capture tuning (`camera_sample.hitPoint`/`hitMesh`, ADR 0030).
   * Only consulted when `capture.gaze` is enabled — tune the ray length or restrict
   * which objects count as a gaze hit.
   */
  gaze?: ThreeGazeOptions;
  /**
   * Scene-actor map for `node_transform` capture (ADR 0027 Tier 1): developer id
   * → three `Object3D` (resolver function, `Object3D.name` string, or direct
   * reference). Pair with `sampling.nodes` to choose which actors are sampled and
   * at what rate — both are required (default OFF). Captures a moving object's
   * world transform so replay can reproduce its motion. Cameras are refused.
   */
  actors?: Record<string, ThreeActor>;
  /**
   * Keyboard bindings to capture as `input_action` events (ADR 0023): a map from
   * `KeyboardEvent.code` (e.g. `"KeyW"`, `"ArrowLeft"`) to a semantic app action
   * (e.g. `"move-forward"`). **Only bound keys are recorded** — unbound keys are
   * never seen, so arbitrary typing is never captured (privacy, ADR 0003).
   */
  keyBindings?: Record<string, string>;
  /** Flush at least this often, in ms. Default 5000. Set 0 to disable the timer. */
  flushIntervalMs?: number;
  /** Provide a custom transport (e.g. to observe delivery). Defaults to beacon/fetch. */
  transport?: Transport;
  /** When true, collect nothing (e.g. respect Do-Not-Track). */
  disabled?: boolean;
  /** Emit debug logs to the console. */
  debug?: boolean;
  /**
   * Free-text label for the scene/experience (e.g. `"product-configurator"`),
   * merged into the auto-detected scene metadata on `session_start`.
   */
  sceneDescription?: string;
  /**
   * Override the detected camera/navigation model on `session_start`. three.js
   * exposes no orbit-vs-free-fly distinction at the camera level (both are a
   * `PerspectiveCamera`), so a host that knows its navigation model — e.g. an
   * orbit-controls viewer vs. a first-person walkthrough — should declare it here
   * so sessions segment correctly (ADR 0026). When omitted, the connector's
   * structural guess from the camera type is used.
   */
  cameraType?: CameraKind;
  /**
   * Caller-supplied, anonymized user context attached to the session. Opt-in.
   * Privacy: `user.id` MUST be pseudonymous/hashed — never PII (ADR 0003).
   */
  user?: SessionUser;
  /** Page metadata / URL overrides for `session_start` (device + scene are filled in for you). */
  meta?: Omit<StartMeta, "device" | "graphics" | "scene" | "user">;
  /**
   * Override the connector provenance identity (ADR 0018). Defaults to the three
   * engine id (`"three"`) and the detected three.js `REVISION`. A connector built
   * **on top of** this one — e.g. `@uptimizr/r3f`, which renders through three —
   * passes `{ name: "r3f" }` so sessions are attributed to it while keeping three's
   * native right-handed coordinate frame (the `coordinateSystem` is always three's).
   */
  connector?: { name?: string; version?: string };
  /**
   * WebXR controller/gaze capture. **On by default** and self-detecting: the
   * collector reads three's always-present `renderer.xr` and stays idle (two event
   * listeners, no timer) until the user actually enters an immersive session, then
   * attaches on `sessionstart` and detaches on `sessionend` — so a scene that boots
   * on desktop and enters XR later is captured with no extra wiring. While in XR it
   * maps controller/gaze pose → `pointer_move` (ray) and `select`/`squeeze` →
   * `pointer_click` / `mesh_interaction` (ADR 0011); the headset's own pose keeps
   * flowing through the regular camera channel. Pass `false` to disable, or an
   * object to tune the pose `sampleMs`, toggle channels (`capture`), or supply a
   * `raycast` probe for in-scene hit resolution (`hitPoint`/`hitMesh`).
   */
  xr?: boolean | { sampleMs?: number; capture?: XrCaptureOptions; raycast?: XrRayProbe };
}

/**
 * One-call three.js integration: create a client, register the three.js collector,
 * read device/GPU caps, and start the session. Returns the {@link UptimizrClient}
 * so the host can read `sessionId`, emit custom events, or `stop()` on teardown.
 *
 * three.js has no `scene.activeCamera` and the connector reads FPS / the canvas
 * from the renderer, so — unlike Babylon's `trackScene(scene, options)` — the
 * `camera` and `renderer` are explicit positional arguments.
 *
 * ```ts
 * import { trackScene } from "@uptimizr/three";
 *
 * const client = trackScene(scene, camera, renderer, {
 *   projectId: "your-project",
 *   endpoint: "https://collect.example.com",
 * });
 * // ... later
 * await client.stop("manual");
 * ```
 *
 * For finer control (custom transport, `beforeSend`, registering multiple
 * collectors), use {@link threeCollector} with a {@link UptimizrClient} directly.
 */
export function trackScene(
  scene: Scene,
  camera: Camera,
  renderer: WebGLRenderer,
  options: TrackSceneOptions,
): UptimizrClient {
  const client = new UptimizrClient({
    projectId: options.projectId,
    endpoint: options.endpoint,
    flushIntervalMs: options.flushIntervalMs,
    transport: options.transport,
    disabled: options.disabled,
    debug: options.debug,
  });

  client.use(
    threeCollector({
      scene,
      camera,
      renderer,
      sampleCameraMs: options.sampleCameraMs,
      samplePerfMs: options.samplePerfMs,
      pointerMoveThrottleMs: options.pointerMoveThrottleMs,
      suppressIdleSamples: options.suppressIdleSamples,
      suppressIdlePerfSamples: options.suppressIdlePerfSamples,
      cameraEpsilon: options.cameraEpsilon,
      perfFpsThreshold: options.perfFpsThreshold,
      capture: options.capture,
      ...(options.gaze ? { gaze: options.gaze } : {}),
      ...(options.actors ? { actors: options.actors } : {}),
      ...(options.keyBindings ? { keyBindings: options.keyBindings } : {}),
      ...(options.sampling ? { sampling: options.sampling } : {}),
    }),
  );

  // WebXR capture is on by default; the collector idles until the user enters an
  // immersive session (auto-detected via `renderer.xr`). Pass `xr: false` to opt out.
  if (options.xr !== false) {
    const xrOpts = options.xr == null || options.xr === true ? {} : options.xr;
    client.use(
      xrCollector({
        renderer: renderer as unknown as XrRendererLike,
        ...(xrOpts.sampleMs != null ? { sampleMs: xrOpts.sampleMs } : {}),
        ...(xrOpts.capture ? { capture: xrOpts.capture } : {}),
        ...(xrOpts.raycast ? { raycast: xrOpts.raycast } : {}),
      }),
    );
  }

  const sceneMeta = {
    ...readSceneMeta(scene, camera),
    ...(options.sceneDescription ? { description: options.sceneDescription } : {}),
    ...(options.cameraType ? { cameraType: options.cameraType } : {}),
  };

  client.start({
    device: readDeviceCaps(renderer),
    graphics: readGraphics(renderer),
    connector: readConnector(options.connector),
    scene: sceneMeta,
    ...(options.user ? { user: options.user } : {}),
    ...options.meta,
  });
  return client;
}
