import { expect, test } from "@playwright/test";

import { API_KEY, CAPTURE_MATRIX_ENGINES, COLLECTOR_URL } from "./constants.js";
import {
  bootEngine,
  driveInteractions,
  enableAllCapture,
  loseAndRestoreContext,
  readSessionEvents,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Exhaustive capture matrix: for each WebGL/WebGPU connector, synthesize the full
 * non-WebXR interaction set (mouse move/click/down/up, mesh pick, orbit gesture,
 * wheel, scene switch, keyboard, resize, GL context loss) and assert each event
 * type made it through the SDK → collector → DuckDB round trip, then that the
 * analytics aggregations the dashboard reads are populated.
 *
 * Event types deliberately out of scope here: WebXR (`xr_*` / immersive) per the
 * task, plus types with no headless trigger (`capability_change`, `asset_load`,
 * `runtime_error`) which are covered by unit/integration tests in their packages.
 */

// Highly reliable across every connector with all capture toggles on.
const CORE_REQUIRED = [
  "session_start",
  "frame_perf",
  "camera_sample",
  "pointer_move",
  "pointer_down",
  "pointer_up",
  "pointer_click",
  "mesh_interaction",
  "custom",
  "camera_gesture",
  "scene_change",
  "context_lost",
] as const;

for (const engineId of CAPTURE_MATRIX_ENGINES) {
  test(`[${engineId}] captures the full event set end to end`, async ({ page, request }) => {
    await enableAllCapture(page, engineId);
    const sessionId = await bootEngine(page, engineId);

    const keyboard = engineId === "babylon";
    await driveInteractions(page, { keyboard });
    await loseAndRestoreContext(page);

    // Babylon also wires demo keyboard bindings → input_action.
    const required = keyboard ? [...CORE_REQUIRED, "input_action"] : [...CORE_REQUIRED];
    const seen = await waitForEventTypes(request, sessionId, required);

    // Every required type is present (waitForEventTypes throws otherwise; assert
    // explicitly so the report lists the captured set on success too).
    for (const type of required) {
      expect(seen, `${engineId} should capture ${type}`).toContain(type);
    }

    // The input-source dimension (ADR 0011) and scene dimension (ADR 0010) survive.
    const events = await readSessionEvents(request, sessionId);
    const sources = new Set(
      events.map((e) => e.source).filter((s): s is string => typeof s === "string"),
    );
    expect(sources, `${engineId} pointer events carry source "mouse"`).toContain("mouse");
    const scenes = new Set(
      events.map((e) => e.sceneId).filter((s): s is string => typeof s === "string"),
    );
    expect(scenes).toContain("lobby");
    expect(scenes).toContain("gallery");

    // The aggregations the dashboard renders are populated for this session.
    const counts = await request
      .get(`${COLLECTOR_URL}/api/v1/event-counts?session=${sessionId}`, {
        headers: { "x-api-key": API_KEY },
      })
      .then((r) => r.json() as Promise<{ event_type: string; count: number }[]>);
    const countedTypes = new Set(counts.map((c) => c.event_type));
    expect(countedTypes).toContain("pointer_click");
    expect(countedTypes).toContain("mesh_interaction");

    const sourceBreakdown = await request
      .get(`${COLLECTOR_URL}/api/v1/interactions/sources?session=${sessionId}`, {
        headers: { "x-api-key": API_KEY },
      })
      .then((r) => r.json() as Promise<{ source: string; count: number }[]>);
    expect(
      sourceBreakdown.some((row) => row.source === "mouse" && row.count > 0),
      `${engineId} input-source breakdown should report mouse interactions`,
    ).toBe(true);
  });
}
