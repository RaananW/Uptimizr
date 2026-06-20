import { UptimizrClient } from "@uptimizr/sdk-core";
import type { StartMeta, Transport, SamplingProfile } from "@uptimizr/sdk-core";
import type { SessionUser, Graphics } from "@uptimizr/schema";
import type { Camera, SceneContext } from "@babylonjs/lite";

import { liteCollector } from "./collector.js";
import type { LiteActor, LiteCaptureOptions, LiteGazeOptions } from "./collector.js";
import type { LitePickProbe } from "./picker.js";
import { readDeviceCaps } from "./device.js";
import { readGraphics, readGraphicsAsync } from "./graphics.js";
import { readConnector } from "./connector.js";
import { readSceneMeta } from "./scene.js";

/**
 * Options for {@link trackScene} — the project/endpoint plus the same sampling and
 * capture knobs as {@link liteCollector}, flattened for one-call setup.
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
   * Per-channel capture-fidelity dial in Hz / `"frame"` / `0`-off (ADR 0012).
   * Governs continuous channels only; discrete events are always captured.
   */
  sampling?: SamplingProfile;
  /** Skip timer-based camera samples while the pose is unchanged. Default true. */
  suppressIdleSamples?: boolean;
  /** Dedupe `frame_perf` samples while FPS is steady. Default false. */
  suppressIdlePerfSamples?: boolean;
  /** Max per-axis pose change treated as "unchanged" for camera dedupe. Default 1e-3. */
  cameraEpsilon?: number;
  /** Max FPS change treated as "unchanged" for perf dedupe. Default 1. */
  perfFpsThreshold?: number;
  /** Toggle individual capture channels. */
  capture?: LiteCaptureOptions;
  /**
   * Gaze probe tuning (`camera_sample.hitPoint`/`hitMesh`, ADR 0030). Only used
   * when `capture.gaze` is enabled. Picks the screen centre via the GPU picker.
   */
  gaze?: LiteGazeOptions;
  /**
   * Scene-actor map for `node_transform` capture (ADR 0027 Tier 1): self-moving
   * Lite nodes (NPCs, lifts, vehicles) whose world transform is recorded so
   * replay can reproduce them. Pair each id with a rate in `sampling.nodes`.
   */
  actors?: Record<string, LiteActor>;
  /** Override the async picking probe (defaults to a Lite GPU picker). */
  picker?: LitePickProbe;
  /**
   * Multiply CSS-pixel pointer coordinates by this factor before picking. Pass
   * `window.devicePixelRatio` when the swapchain backing store is DPR-scaled
   * (Lite's default). Default `1`.
   */
  pickPixelRatio?: number;
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
   * Override the connector provenance identity (ADR 0018). Defaults to the
   * Babylon Lite engine id (`"babylon-lite"`) and the detected Lite `VERSION`.
   */
  connector?: { name?: string; version?: string };
  /**
   * Pre-resolved {@link Graphics} backend block for `session_start` (ADR 0021).
   * Defaults to the synchronous {@link readGraphics} baseline (`webgpu`/`wgsl`,
   * no `backend`). Pass `await readGraphicsAsync()` — or use {@link trackSceneAsync}
   * — to fill in the real WebGPU backend (Metal/D3D12/Vulkan).
   */
  graphics?: Graphics;
}

/**
 * One-call Babylon Lite integration: create a client, register the Lite
 * collector, read device/GPU caps, and start the session. Returns the
 * {@link UptimizrClient} so the host can read `sessionId`, emit custom events, or
 * `stop()` on teardown.
 *
 * Babylon Lite is functional/data-oriented: it has no `scene.activeCamera` the
 * connector can rely on, the app owns the canvas it passed to `createEngine`, and
 * picking is explicit — so the `camera` and `canvas` are passed as explicit
 * positional arguments (mirroring three's `trackScene(scene, camera, renderer, …)`).
 *
 * ```ts
 * import { trackScene } from "@uptimizr/babylon-lite";
 *
 * const client = trackScene(scene, camera, canvas, {
 *   projectId: "your-project",
 *   endpoint: "https://collect.example.com",
 * });
 * // ... later
 * await client.stop("manual");
 * ```
 *
 * For finer control (custom transport, `beforeSend`, registering multiple
 * collectors), use {@link liteCollector} with a {@link UptimizrClient} directly.
 */
export function trackScene(
  scene: SceneContext,
  camera: Camera,
  canvas: HTMLCanvasElement,
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
    liteCollector({
      scene,
      camera,
      canvas,
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
      ...(options.picker ? { picker: options.picker } : {}),
      ...(options.pickPixelRatio !== undefined ? { pickPixelRatio: options.pickPixelRatio } : {}),
      ...(options.sampling ? { sampling: options.sampling } : {}),
    }),
  );

  const sceneMeta = {
    ...readSceneMeta(scene, camera),
    ...(options.sceneDescription ? { description: options.sceneDescription } : {}),
  };

  client.start({
    device: readDeviceCaps(),
    graphics: options.graphics ?? readGraphics(),
    connector: readConnector(options.connector),
    scene: sceneMeta,
    ...(options.user ? { user: options.user } : {}),
    ...options.meta,
  });
  return client;
}

/**
 * Async {@link trackScene}: resolves the real WebGPU backend (Metal/D3D12/Vulkan)
 * via {@link readGraphicsAsync} **before** emitting `session_start`, so the
 * resolved {@link Graphics} block rides on the session descriptor (ADR 0021).
 *
 * Babylon Lite apps are already in an async context (`createEngine` is awaited),
 * so this one extra `await` is free. Equivalent to calling `trackScene` with a
 * pre-resolved `graphics` option; a caller-supplied `options.graphics` wins and
 * skips the adapter round-trip. Resolving the adapter never blocks capture: on any
 * WebGPU failure it falls back to the `webgpu`/`wgsl` baseline.
 *
 * ```ts
 * const client = await trackSceneAsync(scene, camera, canvas, {
 *   projectId: "your-project",
 *   endpoint: "https://collect.example.com",
 * });
 * ```
 */
export async function trackSceneAsync(
  scene: SceneContext,
  camera: Camera,
  canvas: HTMLCanvasElement,
  options: TrackSceneOptions,
): Promise<UptimizrClient> {
  const graphics = options.graphics ?? (await readGraphicsAsync());
  return trackScene(scene, camera, canvas, { ...options, graphics });
}
