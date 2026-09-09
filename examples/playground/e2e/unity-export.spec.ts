import { expect, test } from "@playwright/test";

import { readSessionEvents, waitForEventTypes } from "./helpers/capture.js";
import { UNITY_DIST_DIR, findUnityBuild } from "./helpers/unity-build.js";

/**
 * Unity WebGL export round trip against a **real build** (ADR 0045, #253).
 *
 * `web-export.spec.ts` proves the connector's two tiers with a synthetic bridge push.
 * This spec closes the remaining gap — the engine-side shim (`Uptimizr.jslib` +
 * `UptimizrUnityBridge.cs`) running inside an actual Unity WebGL export — by
 * serving a local build of `examples/unity-web-export/` and letting Unity's own C#
 * `Update()` push camera pose / picks / perf through the real `.jslib`.
 *
 * Unity is not installed in CI, so the build is the maintainer's **one manual step**
 * (File → Build Settings → WebGL → Build into `examples/unity-web-export/dist/`; see
 * that folder's README). Without it this spec **skips** — that is the default here
 * and in CI. The cheap always-on pre-check of the shim is the vitest suite in
 * `oss/packages/unity/src/__tests__/jslib.test.ts`.
 */

const build = findUnityBuild();

test.skip(
  !build,
  `No Unity WebGL build at ${UNITY_DIST_DIR} — build examples/unity-web-export/ (WebGL → dist/) to run this spec`,
);

// A WebAssembly boot (fetch + compile + Unity's scene load) under headless Chromium
// is slow; give the whole round trip generous room.
test.setTimeout(180_000);

const REQUIRED = [
  "session_start",
  "camera_sample", // C# Update() → UptimizrUnityPushPose → bridge.pushPose
  "mesh_interaction", // click → Physics.Raycast → UptimizrUnityPushPick → bridge.pushPick
  "frame_perf", // JS-only rAF loop + UptimizrUnityPushPerf → bridge.pushPerf
] as const;

test("Unity WebGL export drives the bridged tier through the real .jslib shim", async ({
  page,
  request,
}) => {
  const consoleWarnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning" || msg.type() === "error") consoleWarnings.push(msg.text());
  });

  await page.goto("/unity-export-e2e.html");

  // The connector starts synchronously on load, before the export boots.
  await page.waitForFunction(() => typeof window.__unityExport?.sessionId === "string");
  const sessionId = await page.evaluate(() => window.__unityExport!.sessionId);
  expect(sessionId, "unity session id should be stamped").toBeTruthy();

  // Wait for createUnityInstance to resolve (the scene is loaded and Start() ran).
  await page.waitForFunction(
    () => {
      const s = window.__unityExport?.status;
      return s === "ready" || s === "error" || s === "no-build";
    },
    undefined,
    { timeout: 150_000 },
  );
  const state = await page.evaluate(() => ({
    status: window.__unityExport!.status,
    error: window.__unityExport!.error,
    buildName: window.__unityExport!.buildName,
  }));
  expect(state.status, `Unity export should boot (${state.error ?? "no error"})`).toBe("ready");
  expect(state.buildName).toBe(build!.buildName);

  // The C# Start() must have found a matching bridge; on a mismatch it logs this
  // warning and disables itself, and no camera_sample would ever arrive.
  expect(
    consoleWarnings.filter((w) => w.includes("[Uptimizr] bridge protocol mismatch")),
    "the C# bridge should accept the connector's protocol version",
  ).toEqual([]);

  // Pick: click the centre of the canvas. The sample scene's Main Camera sits at
  // (0, 1, -6) looking down +Z with CenterCube at (0, 1, 0), so the ray hits its
  // front face at z ≈ -0.5.
  const canvas = page.locator("#unity-canvas");
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  //
  // Click until the pick lands rather than once. Unity's Input System backend does
  // not deliver pointer input on a just-booted WebGL canvas: measured against a real
  // 6000.6 build, a click fired the moment `createUnityInstance` resolves is dropped,
  // while the same click ~3s later lands every time. Neither `canvas.focus()` nor a
  // priming click helps — only elapsed time does — and the legacy Input Manager never
  // needed it. How long that takes is machine-dependent, so poll instead of sleeping
  // on a magic number. Repeat clicks are harmless: each is the same ray at the same
  // target, so extra picks are duplicates of the one asserted below.
  const clickCentre = async () => {
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
  };

  const pickDeadline = Date.now() + 30_000;
  let picked = false;
  while (!picked && Date.now() < pickDeadline) {
    await clickCentre();
    await page.waitForTimeout(1000);
    picked = (await readSessionEvents(request, sessionId)).some(
      (e) => e.type === "mesh_interaction",
    );
  }
  expect(picked, "a canvas click should raise a pick through the bridge").toBe(true);

  const seen = await waitForEventTypes(request, sessionId, REQUIRED, 30_000);
  for (const type of REQUIRED) {
    expect(seen, `Unity export should capture ${type}`).toContain(type);
  }

  const events = await readSessionEvents(request, sessionId);

  // Provenance: the session is attributed to the unity connector (ADR 0018).
  const start = events.find((e) => e.type === "session_start") as unknown as
    { connector?: { name?: string; coordinateSystem?: { handedness?: string } } } | undefined;
  expect(start?.connector?.name).toBe("unity");
  expect(start?.connector?.coordinateSystem?.handedness).toBe("left");

  // Pose: the C# side pushes position / forward / up + fov (radians) every 250ms.
  const pose = events.find((e) => e.type === "camera_sample") as unknown as
    { position?: number[]; direction?: number[]; fov?: number } | undefined;
  expect(pose?.position?.length).toBe(3);
  expect(pose?.direction?.length).toBe(3);
  expect(pose?.position?.[2], "camera sits at z = -6 in the sample scene").toBeCloseTo(-6, 3);
  expect(pose?.direction?.[2], "camera looks down +Z").toBeCloseTo(1, 3);
  expect(pose?.fov, "60° vertical FOV in radians").toBeCloseTo(Math.PI / 3, 3);

  // Pick: the developer-named object + world hit point, unchanged (Unity's native
  // frame is the canonical wire frame — identity normalization).
  const pick = events.find((e) => e.type === "mesh_interaction") as unknown as
    { mesh?: string; point?: number[] } | undefined;
  expect(pick?.mesh, "centre click hits CenterCube").toBe("CenterCube");
  expect(pick?.point?.length).toBe(3);
  expect(pick?.point?.[2], "hit on CenterCube's front face").toBeCloseTo(-0.5, 1);
});
