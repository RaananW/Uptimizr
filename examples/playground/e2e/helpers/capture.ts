/**
 * Shared helpers for the capture → collector → DB e2e specs. They drive the
 * consolidated playground (one Vite origin, `?engine=<id>`) through every
 * interaction we can synthesize from a headless browser, then read the stored
 * timeline back from the collector to assert each event type survived the full
 * browser → SDK → collector → DuckDB round trip.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL } from "../constants.js";

/** A loose view of the stored `AnyEvent` envelope the specs assert on. */
export interface CapturedEvent {
  type: string;
  sessionId: string;
  sceneId?: string;
  source?: string;
  ts: number;
}

/**
 * Enable every capture toggle for an engine before the page boots. The shell
 * reads each engine's capture config from `localStorage` at init time, so this
 * must run via `page.addInitScript` *before* `page.goto`. Unknown keys are
 * ignored by the shell, so a superset is safe across engines.
 */
export async function enableAllCapture(page: Page, engineId: string): Promise<void> {
  const config: Record<string, boolean> = {
    camera: true,
    pointerMove: true,
    clicks: true,
    buttons: true,
    meshPicks: true,
    perf: true,
    contextLoss: true,
    compileStall: true,
    meshVisibility: true,
    hoverDwell: true,
    resourceSample: true,
    keyboard: true,
  };
  await page.addInitScript(
    ([id, cfg]) => {
      try {
        localStorage.setItem(`uptimizr.playground.${id}.capture`, JSON.stringify(cfg));
      } catch {
        /* ignore storage failure */
      }
    },
    [engineId, config] as const,
  );
}

/** Boot the playground for an engine and return its stamped session id. */
export async function bootEngine(page: Page, engineId: string): Promise<string> {
  await page.goto(`/?engine=${engineId}`);
  // Collector reachable (the panel's /health ping flips the dot green).
  await expect(page.locator("#connDot")).toHaveClass(/ok/);
  // The session id is stamped synchronously once the connector starts.
  await expect(page.locator("#sessionId")).not.toHaveText("…");
  const sessionId = (await page.locator("#sessionId").textContent())?.trim();
  expect(sessionId, "session id should be stamped").toBeTruthy();
  return sessionId as string;
}

/** Absolute client coordinates for a fractional point inside the viewport. */
function viewportPoint(page: Page, fx: number, fy: number): { x: number; y: number } {
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  return { x: Math.round(width * fx), y: Math.round(height * fy) };
}

/**
 * Drive the full interaction set against the 3D canvas:
 * pointer move, a center mesh pick (mesh_interaction + custom), discrete
 * down/up/click, an orbit drag (camera_gesture), a wheel, a scene switch
 * (scene_change), a viewport resize, and — when `keyboard` — key presses
 * (input_action). Returns nothing; assertions read the stored timeline back.
 */
export async function driveInteractions(
  page: Page,
  opts: { keyboard?: boolean } = {},
): Promise<void> {
  const mouse = page.mouse;

  // 1) Pointer move across the lower canvas (away from the top-left info panel).
  const a = viewportPoint(page, 0.55, 0.68);
  const b = viewportPoint(page, 0.7, 0.74);
  await mouse.move(a.x, a.y, { steps: 8 });
  await mouse.move(b.x, b.y, { steps: 8 });

  // 2) Mesh pick at canvas center → mesh_interaction + a `box_picked` custom event.
  const center = viewportPoint(page, 0.5, 0.52);
  await mouse.move(center.x, center.y, { steps: 4 });
  await mouse.click(center.x, center.y);

  // 3) Discrete pointer down/up (off-center, to bracket button capture).
  await mouse.move(b.x, b.y, { steps: 4 });
  await mouse.down();
  await mouse.up();

  // 4) Orbit drag → a camera_gesture (down → several moves → up, camera moves).
  await mouse.move(a.x, a.y, { steps: 2 });
  await mouse.down();
  for (let i = 1; i <= 6; i += 1) {
    await mouse.move(a.x + i * 22, a.y + i * 6, { steps: 2 });
  }
  await mouse.up();

  // 5) Wheel (dolly/zoom + extra camera samples).
  await mouse.move(center.x, center.y);
  await mouse.wheel(0, -240);
  await mouse.wheel(0, 180);

  // 6) Scene/area switch (ADR 0010) → scene_change; later events carry "gallery".
  await page.locator("#sceneGallery").click();
  await expect(page.locator("#currentScene")).toHaveText("gallery");

  // 7) Keyboard demo bindings (Babylon) → input_action.
  if (opts.keyboard) {
    // Focus the canvas via a real pointer click at its center. A `locator.click`
    // near the top-left corner is intercepted by the always-on `#topbar`
    // overlay; `mouse.click` dispatches at absolute coords (like the steps
    // above) and still sets DOM focus on the `tabindex`-enabled canvas.
    await mouse.click(center.x, center.y);
    await page.keyboard.press("n");
    await page.keyboard.press("Space");
    await page.keyboard.press("n");
  }

  // 8) Viewport resize → viewport_resize.
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ width: vp.width - 80, height: vp.height - 60 });
  await page.setViewportSize(vp);
}

/**
 * Emulate a GPU context loss + restore on the engine's WebGL canvas via the
 * `WEBGL_lose_context` extension — the closest a headless browser gets to a real
 * "GL error". Drives `context_lost` (and, when the engine re-acquires, a
 * `context_restored`). No-op-safe: returns whether the extension was available.
 */
export async function loseAndRestoreContext(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const canvas = document.getElementById("renderCanvas");
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const gl =
      canvas.getContext("webgl2") ?? (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return false;
    const ext = gl.getExtension("WEBGL_lose_context");
    if (!ext) return false;
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 150));
    try {
      ext.restoreContext();
    } catch {
      /* some engines re-create the context themselves */
    }
    await new Promise((r) => setTimeout(r, 150));
    return true;
  });
}

/** Read the stored, ordered timeline for a session from the collector. */
export async function readSessionEvents(
  request: APIRequestContext,
  sessionId: string,
): Promise<CapturedEvent[]> {
  const res = await request.get(`${COLLECTOR_URL}/api/v1/sessions/${sessionId}/events`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(
    res.ok(),
    `events read for ${sessionId} should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
  return (await res.json()) as CapturedEvent[];
}

/**
 * Poll the stored timeline until every `required` event type has appeared (the
 * SDK auto-flushes on an interval, so the round trip is eventually-consistent).
 * Returns the full set of captured types once satisfied, or throws on timeout.
 */
export async function waitForEventTypes(
  request: APIRequestContext,
  sessionId: string,
  required: readonly string[],
  timeoutMs = 20_000,
): Promise<Set<string>> {
  const deadline = Date.now() + timeoutMs;
  let seen = new Set<string>();
  for (;;) {
    const events = await readSessionEvents(request, sessionId);
    seen = new Set(events.map((e) => e.type));
    if (required.every((t) => seen.has(t))) return seen;
    if (Date.now() > deadline) {
      const missing = required.filter((t) => !seen.has(t));
      throw new Error(
        `timed out waiting for event types [${missing.join(", ")}] in session ${sessionId}; ` +
          `saw [${[...seen].sort().join(", ")}]`,
      );
    }
    await new Promise((r) => setTimeout(r, 750));
  }
}
