/**
 * Global (IIFE) entry for `@uptimizr/replay` — exposes `window.UptimizrReplay`
 * for `<script>`-tag use (e.g. on playground.babylonjs.com), mirroring the
 * collector's `window.Uptimizr`.
 *
 * Unlike the npm entry (where `@babylonjs/core` is a peer dependency the host app
 * provides), this build bundles the small `Vector3` value the Babylon driver
 * constructs to push camera pose. The host page's Babylon still owns the scene;
 * we only hand it plain `{x,y,z}` vectors, so a separately-bundled `Vector3` is
 * interchangeable.
 */
import type { Camera, Scene } from "@babylonjs/core";
import { createBabylonReplayDriver, type BabylonReplayDriverOptions } from "./drivers/babylon.js";
import { fetchSessionEvents, fetchSessionEventsStream } from "./fetchSession.js";
import { ReplayPlayer } from "./player.js";
import type { AnyEvent } from "@uptimizr/schema";
import type { ReplayHandle } from "./types.js";

/** One-call replay: fetch a session and re-drive it in the given Babylon scene. */
export interface ReplayInSceneOptions {
  /** Scene to re-drive. */
  scene: Scene;
  /** Collector base URL, e.g. `https://collect.example.com`. */
  endpoint: string;
  /** Project API key (sent as `x-api-key`). */
  apiKey: string;
  /** Session id to replay. */
  sessionId: string;
  /** Camera to move. Defaults to `scene.activeCamera`. */
  camera?: Camera;
  /** Playback speed multiplier. Default 1. */
  speed?: number;
  /** Per pointer event, so the host can render a cursor/marker. */
  onPointer?: BabylonReplayDriverOptions["onPointer"];
  /** Per mesh interaction, so the host can highlight a mesh. */
  onMeshInteraction?: BabylonReplayDriverOptions["onMeshInteraction"];
  /** Per developer-defined `custom` event. */
  onCustom?: BabylonReplayDriverOptions["onCustom"];
  /** Per browser/engine lifecycle event (resize, visibility, focus, context loss). */
  onLifecycle?: BabylonReplayDriverOptions["onLifecycle"];
  /** Per captured `runtime_error` event (opt-in capture). */
  onError?: BabylonReplayDriverOptions["onError"];
  /** Progress callback (clamped elapsed and total duration, in ms). */
  onProgress?: (elapsedMs: number, durationMs: number) => void;
  /** Called once when playback reaches the end. */
  onComplete?: () => void;
  /** Log each step (fetch, event counts, play, progress, complete) to the console. */
  debug?: boolean;
}

const LOG_PREFIX = "[UptimizrReplay]";

/**
 * Fetch a captured session from the collector and play it back in `scene`,
 * starting immediately. Returns the {@link ReplayHandle} so callers can
 * pause/seek/stop. The collector must have raw-session retention enabled for the
 * session-events endpoint to return data (ADR 0003).
 *
 * Emits a concise console summary (and, with `debug: true`, per-step logs) so it
 * is clear whether playback is running. The common "nothing happens" causes —
 * an empty session, a session with no `camera_sample` events, or a scene with no
 * active camera — are surfaced as console warnings.
 */
export async function replayInScene(options: ReplayInSceneOptions): Promise<ReplayHandle> {
  const debug = options.debug ?? false;
  const log = (...args: unknown[]): void => {
    if (debug) console.info(LOG_PREFIX, ...args);
  };

  log(`fetching session "${options.sessionId}" from ${options.endpoint}`);
  let events: AnyEvent[];
  try {
    // Stream the session (NDJSON when the collector supports it) and accumulate
    // into an array for the full-session player. Streaming keeps server memory
    // bounded and validates per line, with a transparent JSON-array fallback for
    // older collectors (ADR 0015).
    events = [];
    let malformed = 0;
    for await (const event of fetchSessionEventsStream({
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      sessionId: options.sessionId,
      onMalformedLine: (count) => {
        malformed = count;
      },
    })) {
      events.push(event);
    }
    if (malformed > 0) {
      console.warn(
        `${LOG_PREFIX} skipped ${malformed} malformed event line(s) while streaming the session.`,
      );
    }
  } catch (err) {
    // Surface fetch failures (e.g. 403 when raw retention is disabled, 401 for a
    // bad key) instead of letting them vanish into an unhandled rejection.
    console.error(`${LOG_PREFIX} failed to fetch session events:`, err);
    throw err;
  }

  const cameraSamples = events.filter((e) => e.type === "camera_sample").length;
  if (events.length === 0) {
    // A 200 with an empty array almost always means the API key belongs to a
    // different project than the session. Reads are scoped to the key's project
    // (the collector filters by project_id), so a valid session id looked up
    // with another project's key returns no rows. Lead with that cause.
    console.error(
      `${LOG_PREFIX} session "${options.sessionId}" returned 0 events — nothing to replay. ` +
        `Most likely the API key belongs to a different project than this session: ` +
        `copy the session id and the API key from the SAME dashboard project. ` +
        `Other causes: a mistyped session id, or the collector not having ` +
        `ENABLE_RAW_SESSION_RETENTION=true.`,
    );
  } else if (cameraSamples === 0) {
    console.warn(
      `${LOG_PREFIX} session has ${events.length} events but no camera_sample events, ` +
        `so the camera won't move. Pointer/mesh/custom callbacks will still fire.`,
    );
  }

  const activeCamera = options.camera ?? options.scene.activeCamera;
  if (!activeCamera) {
    console.warn(
      `${LOG_PREFIX} scene has no active camera and none was provided — camera pose ` +
        `won't be applied. Pass a \`camera\`, or set \`scene.activeCamera\` before replaying.`,
    );
  }

  const driver = createBabylonReplayDriver({
    scene: options.scene,
    camera: options.camera,
    onPointer: options.onPointer,
    onMeshInteraction: options.onMeshInteraction,
    onCustom: options.onCustom,
    onLifecycle: options.onLifecycle,
    onError: options.onError,
  });
  const player = new ReplayPlayer(events, driver, {
    speed: options.speed ?? 1,
    onProgress: options.onProgress,
    onComplete: () => {
      log("playback complete");
      options.onComplete?.();
    },
  });

  log(
    `loaded ${events.length} events (${cameraSamples} camera_sample), ` +
      `duration ${Math.round(player.durationMs)}ms — playing at ${options.speed ?? 1}x`,
  );
  player.play();
  return player;
}

export { createBabylonReplayDriver, fetchSessionEvents, fetchSessionEventsStream, ReplayPlayer };
export type { BabylonReplayDriverOptions, ReplayHandle };
