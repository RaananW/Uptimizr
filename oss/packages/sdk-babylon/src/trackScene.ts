import { UptimizrClient } from "@uptimizr/sdk-core";
import type { StartMeta, Transport, SamplingProfile } from "@uptimizr/sdk-core";
import type { SessionUser } from "@uptimizr/schema";
import type { Camera, Scene } from "@babylonjs/core";

import { babylonCollector } from "./collector.js";
import type {
  BabylonActor,
  BabylonCaptureOptions,
  GazeOptions,
  MeshVisibilityOptions,
} from "./collector.js";
import { babylonXrCollector } from "./xr.js";
import type { BabylonXrExperienceLike } from "./xr.js";
import { readDeviceCaps } from "./device.js";
import { readGraphics } from "./graphics.js";
import { readConnector } from "./connector.js";
import { readSceneMeta } from "./scene.js";
import type { XrCaptureOptions, XrRayProbe } from "@uptimizr/sdk-core";

/**
 * Options for {@link trackScene} — the project/endpoint plus the same sampling and
 * capture knobs as {@link babylonCollector}, flattened for one-call setup.
 */
export interface TrackSceneOptions {
  /** Project identifier (public, non-secret). */
  projectId: string;
  /** Collector endpoint base URL, e.g. `https://collect.example.com`. */
  endpoint: string;
  /**
   * Camera to record for the view-direction / pose timeline. Defaults to
   * `scene.activeCamera` (falling back to the first of `scene.activeCameras`).
   * **Set this for multi-camera scenes** (picture-in-picture, split-screen, RTT
   * rigs) where `scene.activeCamera` is ambiguous — otherwise the recorded pose
   * can be a fixed, wrong viewpoint. Pass the camera the viewer actually flies.
   */
  camera?: Camera;
  /** Camera-pose sampling interval in ms. Default 1000. */
  sampleCameraMs?: number;
  /** Performance (FPS) sampling interval in ms. Default 2000. */
  samplePerfMs?: number;
  /**
   * Frame-time threshold in ms above which a frame counts as a "long frame"
   * (jank) for `frame_perf.longFrames` (#41). Default 50.
   */
  jankFrameMs?: number;
  /** Minimum gap between `pointer_move` samples in ms. Default 250. */
  pointerMoveThrottleMs?: number;
  /**
   * Per-channel capture-fidelity dial in Hz / `"frame"` / `0`-off (ADR 0012),
   * e.g. `{ camera: 10, pointerMove: 60, perf: 0.5 }`. Governs continuous
   * channels only; discrete events (clicks, picks, scene changes, ...) are always
   * captured. Overrides the matching legacy ms knob; omitted channels keep the
   * conservative defaults. No enforced ceiling — higher fidelity costs storage.
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
  capture?: BabylonCaptureOptions;
  /**
   * Per-object dwell / attention capture config (`mesh_visibility`, #37). Only
   * used when `capture.meshVisibility` is enabled (off by default — privacy,
   * ADR 0003). Emits one bucketed summary per tracked object per window.
   */
  meshVisibility?: MeshVisibilityOptions;
  /**
   * World-space gaze raycast config (`camera_sample.hitPoint`/`hitMesh`, ADR
   * 0030). Only used when `capture.gaze` is enabled (off by default — privacy +
   * cost, ADR 0003 / ADR 0012). Each emitted camera sample raycasts the
   * camera-forward ray into the scene and attaches the surface hit, powering the
   * world-space gaze heatmap ("what did people actually look at").
   */
  gaze?: GazeOptions;
  /**
   * Allowlist mapping a physical `KeyboardEvent.code` to a semantic action label
   * (ADR 0023). When non-empty, the connector captures `input_action` events for
   * those keys only — arbitrary typing is never recorded (privacy-first, ADR 0003)
   * and auto-repeat is suppressed. Example: `{ KeyN: "next-camera", Space: "jump" }`.
   */
  keyBindings?: Record<string, string>;
  /**
   * Scene-actor map for `node_transform` capture (ADR 0027 Tier 1): developer id
   * → Babylon node (resolver function, engine name string, or direct reference).
   * Pair with `sampling.nodes` to choose which actors are sampled and at what
   * rate — both are required (default OFF). Captures a moving node's world
   * transform so replay can reproduce its motion. Cameras are refused.
   */
  actors?: Record<string, BabylonActor>;
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
   * Caller-supplied, anonymized user context attached to the session. Opt-in.
   * Privacy: `user.id` MUST be pseudonymous/hashed — never PII (ADR 0003).
   */
  user?: SessionUser;
  /** Page metadata / URL overrides for `session_start` (device + scene are filled in for you). */
  meta?: Omit<StartMeta, "device" | "graphics" | "scene" | "user">;
  /**
   * Opt-in WebXR controller capture (off by default — desktop scenes don't need
   * it). In an immersive session Babylon's `WebXRCamera` pose flows through the
   * regular camera channel passively; this enables the {@link babylonXrCollector},
   * which maps controller pose → `pointer_move` (ray) and trigger/squeeze →
   * `pointer_click` / `mesh_interaction` (ADR 0011). Pass the
   * `WebXRDefaultExperience` returned by `scene.createDefaultXRExperienceAsync()`
   * as `experience`; optionally tune the pose `sampleMs`, toggle channels
   * (`capture`), or supply a `raycast` probe for in-scene hit resolution.
   */
  xr?: {
    experience: BabylonXrExperienceLike;
    sampleMs?: number;
    capture?: XrCaptureOptions;
    raycast?: XrRayProbe;
  };
}

/**
 * One-call Babylon integration: create a client, register the Babylon collector,
 * read device/GPU caps, and start the session. Returns the {@link UptimizrClient}
 * so the host can read `sessionId`, emit custom events, or `stop()` on teardown.
 *
 * ```ts
 * import { trackScene } from "@uptimizr/babylon";
 *
 * const client = trackScene(scene, {
 *   projectId: "your-project",
 *   endpoint: "https://collect.example.com",
 * });
 * // ... later
 * await client.stop("manual");
 * ```
 *
 * For finer control (custom transport, `beforeSend`, registering multiple
 * collectors), use {@link babylonCollector} with a {@link UptimizrClient} directly.
 */
export function trackScene(scene: Scene, options: TrackSceneOptions): UptimizrClient {
  const client = new UptimizrClient({
    projectId: options.projectId,
    endpoint: options.endpoint,
    flushIntervalMs: options.flushIntervalMs,
    transport: options.transport,
    disabled: options.disabled,
    debug: options.debug,
  });

  client.use(
    babylonCollector({
      scene,
      ...(options.camera ? { camera: options.camera } : {}),
      sampleCameraMs: options.sampleCameraMs,
      samplePerfMs: options.samplePerfMs,
      jankFrameMs: options.jankFrameMs,
      pointerMoveThrottleMs: options.pointerMoveThrottleMs,
      suppressIdleSamples: options.suppressIdleSamples,
      suppressIdlePerfSamples: options.suppressIdlePerfSamples,
      cameraEpsilon: options.cameraEpsilon,
      perfFpsThreshold: options.perfFpsThreshold,
      capture: options.capture,
      ...(options.meshVisibility ? { meshVisibility: options.meshVisibility } : {}),
      ...(options.gaze ? { gaze: options.gaze } : {}),
      ...(options.keyBindings ? { keyBindings: options.keyBindings } : {}),
      ...(options.actors ? { actors: options.actors } : {}),
      ...(options.sampling ? { sampling: options.sampling } : {}),
    }),
  );

  if (options.xr) {
    client.use(
      babylonXrCollector({
        experience: options.xr.experience,
        ...(options.xr.sampleMs != null ? { sampleMs: options.xr.sampleMs } : {}),
        ...(options.xr.capture ? { capture: options.xr.capture } : {}),
        ...(options.xr.raycast ? { raycast: options.xr.raycast } : {}),
      }),
    );
  }

  const sceneMeta = {
    ...readSceneMeta(scene, options.camera),
    ...(options.sceneDescription ? { description: options.sceneDescription } : {}),
  };

  client.start({
    device: readDeviceCaps(scene),
    graphics: readGraphics(scene),
    connector: readConnector(scene),
    scene: sceneMeta,
    ...(options.user ? { user: options.user } : {}),
    ...options.meta,
  });
  return client;
}
