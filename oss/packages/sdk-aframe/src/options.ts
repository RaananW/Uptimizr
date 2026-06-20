import type { TrackSceneOptions, ThreeCaptureOptions } from "@uptimizr/three";

import type { UptimizrComponentData } from "./types.js";

/**
 * Translate the declarative `uptimizr` component {@link UptimizrComponentData}
 * into the three connector's {@link TrackSceneOptions}.
 *
 * A-Frame renders three.js, so capture is entirely `@uptimizr/three`; this only
 * maps the component's flat schema onto the connector's options and stamps the
 * connector provenance. Numeric `0` sentinels mean "unset" so the three
 * connector's own defaults apply (the component schema can't express "absent").
 * The opt-in `capture` channels (`meshVisibility`/`hoverDwell`/`resourceSample`)
 * are off unless explicitly enabled (privacy, ADR 0003).
 *
 * The session is attributed to the A-Frame connector (`connector.name ===
 * "aframe"`) while keeping three's native right-handed coordinate frame; the
 * `version` is the A-Frame library version when discoverable (`AFRAME.version`).
 */
export function buildTrackOptions(
  data: UptimizrComponentData,
  libraryVersion?: string,
): TrackSceneOptions {
  const capture: ThreeCaptureOptions = {};
  if (data.meshVisibility) capture.meshVisibility = true;
  if (data.hoverDwell) capture.hoverDwell = true;
  if (data.resourceSample) capture.resourceSample = true;
  // World-space gaze raycast is opt-in (privacy + cost, ADR 0003 / ADR 0030). The
  // flat A-Frame schema can't express an allowlist/predicate, so it's a plain
  // on/off toggle; the three connector's GazeOptions defaults (maxDistance 1000,
  // any-mesh) apply.
  if (data.gaze) capture.gaze = true;
  // camera_gesture is on by default in three (ADR 0025); only forward an opt-out.
  if (!data.cameraGesture) capture.cameraGesture = false;

  const options: TrackSceneOptions = {
    projectId: data.projectId,
    endpoint: data.collector,
    // Attribute the session to the A-Frame connector while inheriting three's frame.
    connector: { name: "aframe", ...(libraryVersion ? { version: libraryVersion } : {}) },
    debug: data.debug,
  };
  if (data.sampleCameraMs > 0) options.sampleCameraMs = data.sampleCameraMs;
  if (data.samplePerfMs > 0) options.samplePerfMs = data.samplePerfMs;
  if (data.pointerMoveThrottleMs > 0) options.pointerMoveThrottleMs = data.pointerMoveThrottleMs;
  if (data.sceneDescription) options.sceneDescription = data.sceneDescription;
  if (Object.keys(capture).length > 0) options.capture = capture;
  // WebXR capture is on by default in three (auto-detects session entry). A-Frame is
  // WebXR-first, so we only forward an override: disable it, or set the sample rate.
  if (!data.xr) options.xr = false;
  else if (data.xrSampleMs > 0) options.xr = { sampleMs: data.xrSampleMs };
  return options;
}
