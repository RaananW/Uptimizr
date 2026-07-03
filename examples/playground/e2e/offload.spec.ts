import { expect, test } from "@playwright/test";

import { CAPTURE_MATRIX_ENGINES } from "./constants.js";
import {
  bootEngine,
  driveInteractions,
  enableAllCapture,
  readSessionEvents,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Worker-offload parity (issue #10 / ADR 0041). The same connector interactions
 * that the capture matrix drives on the default main-thread aggregator are
 * replayed here with `?offload=worker`, so per-frame aggregation (frame-time
 * percentiles, matrix decomposition, mesh-visibility bucketing, gesture
 * classification, idle-diffing) runs inside the offload worker instead of on the
 * render thread. The finalized analytics events must still complete the
 * browser → SDK → worker → collector → DuckDB round trip.
 */

// The aggregation-derived channels are the ones the worker now owns end to end;
// the rest are pass-through but must still survive the worker boundary.
const OFFLOAD_REQUIRED = [
  "session_start",
  "frame_perf", // frame-time percentiles aggregated in the worker
  "camera_sample", // pose idle-diff in the worker (pre-gated gaze stays main-thread)
  "camera_gesture", // gesture classification in the worker
  "pointer_move",
  "pointer_click",
  "mesh_interaction",
  "scene_change",
] as const;

for (const engineId of CAPTURE_MATRIX_ENGINES) {
  test(`[${engineId}] worker offload round-trips the aggregated event set`, async ({
    page,
    request,
  }) => {
    await enableAllCapture(page, engineId);
    const sessionId = await bootEngine(page, engineId, undefined, "worker");

    await driveInteractions(page, { keyboard: engineId === "babylon" });

    const seen = await waitForEventTypes(request, sessionId, [...OFFLOAD_REQUIRED]);
    for (const type of OFFLOAD_REQUIRED) {
      expect(seen, `${engineId} (offload=worker) should capture ${type}`).toContain(type);
    }

    // Aggregation dimensions (source ADR 0011, scene ADR 0010) survive the worker hop.
    const events = await readSessionEvents(request, sessionId);
    const sources = new Set(
      events.map((e) => e.source).filter((s): s is string => typeof s === "string"),
    );
    expect(sources, `${engineId} (offload=worker) pointer events carry source "mouse"`).toContain(
      "mouse",
    );
    const scenes = new Set(
      events.map((e) => e.sceneId).filter((s): s is string => typeof s === "string"),
    );
    expect(scenes).toContain("lobby");
    expect(scenes).toContain("gallery");
  });
}
