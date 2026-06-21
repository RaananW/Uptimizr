import { UptimizrClient } from "@uptimizr/sdk-core";
import type { StartMeta, Transport, SamplingProfile } from "@uptimizr/sdk-core";
import type { CameraKind, SessionUser } from "@uptimizr/schema";
import type { AppBase, Entity } from "playcanvas";

import { playcanvasCollector } from "./collector.js";
import type {
  PlayCanvasActor,
  PlayCanvasCaptureOptions,
  PlayCanvasGazeOptions,
} from "./collector.js";
import { readDeviceCaps } from "./device.js";
import { readGraphics } from "./graphics.js";
import { readConnector } from "./connector.js";
import { readSceneMeta } from "./scene.js";

/**
 * Options for {@link trackScene} — the project/endpoint plus the same sampling and
 * capture knobs as {@link playcanvasCollector}, flattened for one-call setup.
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
  capture?: PlayCanvasCaptureOptions;
  /**
   * Gaze probe tuning (`camera_sample.hitPoint`/`hitMesh`, ADR 0030). Only used
   * when `capture.gaze` is enabled. Casts the camera-forward ray per sample.
   */
  gaze?: PlayCanvasGazeOptions;
  /**
   * Scene-actor map for `node_transform` capture (ADR 0027 Tier 1): self-moving
   * nodes (NPCs, lifts, vehicles) whose world transform is recorded so replay can
   * reproduce them. Pair each id with a rate in `sampling.nodes` to enable it.
   */
  actors?: Record<string, PlayCanvasActor>;
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
   * Override the detected camera/navigation model on `session_start`. PlayCanvas
   * camera entities carry no orbit-vs-free-fly distinction, so a host that knows
   * its navigation model — e.g. an orbit viewer vs. a first-person walkthrough —
   * should declare it here so sessions segment correctly (ADR 0026). When omitted,
   * the connector's structural guess is used.
   */
  cameraType?: CameraKind;
  /**
   * Caller-supplied, anonymized user context attached to the session. Opt-in.
   * Privacy: `user.id` MUST be pseudonymous/hashed — never PII (ADR 0003).
   */
  user?: SessionUser;
  /** Page metadata / URL overrides for `session_start` (device + scene are filled in for you). */
  meta?: Omit<StartMeta, "device" | "graphics" | "scene" | "user">;
}

/**
 * One-call PlayCanvas integration: create a client, register the PlayCanvas
 * collector, read device/GPU caps, and start the session. Returns the
 * {@link UptimizrClient} so the host can read `sessionId`, emit custom events, or
 * `stop()` on teardown.
 *
 * PlayCanvas supports multiple camera entities with no single "active" camera, and
 * the connector reads FPS / the canvas from the app's graphics device, so — unlike
 * Babylon's `trackScene(scene, options)` — the `camera` Entity is an explicit
 * positional argument (mirroring the three connector).
 *
 * ```ts
 * import { trackScene } from "@uptimizr/playcanvas";
 *
 * const client = trackScene(app, cameraEntity, {
 *   projectId: "your-project",
 *   endpoint: "https://collect.example.com",
 * });
 * // ... later
 * await client.stop("manual");
 * ```
 *
 * For finer control (custom transport, `beforeSend`, registering multiple
 * collectors), use {@link playcanvasCollector} with a {@link UptimizrClient} directly.
 */
export function trackScene(
  app: AppBase,
  camera: Entity,
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
    playcanvasCollector({
      app,
      camera,
      sampleCameraMs: options.sampleCameraMs,
      samplePerfMs: options.samplePerfMs,
      pointerMoveThrottleMs: options.pointerMoveThrottleMs,
      suppressIdleSamples: options.suppressIdleSamples,
      suppressIdlePerfSamples: options.suppressIdlePerfSamples,
      cameraEpsilon: options.cameraEpsilon,
      perfFpsThreshold: options.perfFpsThreshold,
      capture: options.capture,
      ...(options.gaze ? { gaze: options.gaze } : {}),
      ...(options.sampling ? { sampling: options.sampling } : {}),
      ...(options.actors ? { actors: options.actors } : {}),
      ...(options.keyBindings ? { keyBindings: options.keyBindings } : {}),
    }),
  );

  const sceneMeta = {
    ...readSceneMeta(app, camera),
    ...(options.sceneDescription ? { description: options.sceneDescription } : {}),
    ...(options.cameraType ? { cameraType: options.cameraType } : {}),
  };

  client.start({
    device: readDeviceCaps(app),
    graphics: readGraphics(app),
    connector: readConnector(),
    scene: sceneMeta,
    ...(options.user ? { user: options.user } : {}),
    ...options.meta,
  });
  return client;
}
