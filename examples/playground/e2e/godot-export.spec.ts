import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { readSessionEvents, waitForEventTypes } from "./helpers/capture.js";

/**
 * Godot bridged-tier round trip through a REAL engine (ADR 0045, #252).
 *
 * `web-export.spec.ts` proves the connector's JS surface with synthetic bridge
 * pushes. This spec proves the **engine-side shim** actually runs: it boots the
 * headless Web export of `examples/godot-web-export` (Godot 4, built by
 * `pnpm godot:fetch && pnpm godot:export`, served by the playground's Vite plugin
 * under `/godot-export/`) via `/godot-export-e2e.html`, which starts the real
 * `@uptimizr/godot` connector before the engine boots. The exported project's
 * `UptimizrGodot.gd` autoload — a byte-identical copy of the shipped shim — then
 * finds `window.__uptimizr_godot__` and pushes:
 *
 *  - camera pose every frame (throttled) → `camera_sample`, Z-negated by the
 *    connector (Godot is right-handed);
 *  - FPS → `frame_perf`;
 *  - a left-click physics raycast → `mesh_interaction` naming the collider; and
 *  - the opt-in scene proxy (`main.gd` marks the props and calls
 *    `push_scene_proxy()`).
 *
 * The spec clicks the canvas centre (the `Crate` sits on the camera's axis) and
 * asserts each channel reached the collector with Godot's frame normalized.
 *
 * Skips cleanly when no export has been built, so the default suite stays green on
 * machines without Godot. CI's `godot-export-e2e` job sets `GODOT_E2E_REQUIRED=1`
 * to turn a missing export into a failure.
 */

const EXPORT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../godot-web-export/dist");
const EXPORT_FILES = ["index.js", "index.wasm", "index.pck"] as const;
const exportPresent = EXPORT_FILES.every((f) => existsSync(resolve(EXPORT_DIR, f)));
const HOW_TO = "run 'pnpm godot:fetch && pnpm godot:export' to build it";

if (!exportPresent && process.env.GODOT_E2E_REQUIRED === "1") {
  throw new Error(`GODOT_E2E_REQUIRED=1 but no Godot web export in ${EXPORT_DIR} — ${HOW_TO}`);
}
test.skip(!exportPresent, `no Godot web export in ${EXPORT_DIR} — ${HOW_TO}`);

const REQUIRED = [
  "session_start",
  "camera_sample", // autoload _push_pose → bridge.pushPose
  "frame_perf", // autoload _push_perf → bridge.pushPerf (+ the JS-only rAF loop)
  "mesh_interaction", // autoload _push_pick_at → bridge.pushPick
  "pointer_click", // JS-only tier, straight off the canvas DOM
] as const;

/** Scene layout in Godot's native frame (see `examples/godot-web-export/main.tscn`). */
const CAMERA_POS = [0, 1.5, 6] as const; // looks down -Z at the crate
const CRATE_FRONT_Z = 0.5; // 1 m box centred at z=0 → the ray hits its +Z face
const ORB_Z_RANGE = [-1.5, -0.5] as const; // 1 m sphere centred at z=-1

test("Godot web export drives the bridged tier through the shipped autoload", async ({
  page,
  request,
}) => {
  // A ~38 MB WASM compile + software WebGL boot is slow on CI runners.
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto("/godot-export-e2e.html");
  await page.waitForFunction(
    () => {
      const s = window.__godotExport?.status;
      return s === "running" || s === "failed" || s === "missing-export" || s === "no-webgl";
    },
    undefined,
    { timeout: 180_000 },
  );
  const boot = await page.evaluate(() => {
    const h = window.__godotExport!;
    return { status: h.status, error: h.error, sessionId: h.sessionId, log: h.log };
  });
  expect(
    boot.status,
    `engine should boot (error: ${boot.error ?? "-"}; log: ${boot.log.join(" | ")}; page errors: ${pageErrors.join(" | ")})`,
  ).toBe("running");
  const sessionId = boot.sessionId;
  expect(sessionId, "godot session id should be stamped").toBeTruthy();

  // The shim warns (push_warning → stderr) and disables itself when it can't find the
  // bridge or the protocol version mismatches. Neither may happen here.
  expect(boot.log.join("\n"), "autoload must have attached to the bridge").not.toContain(
    "[Uptimizr]",
  );

  // Let the shim push at least one pose before clicking, so the pick lands on a
  // fully booted, rendering engine.
  await waitForEventTypes(request, sessionId, ["camera_sample"], 90_000);

  // Left-click the canvas centre: Godot turns the DOM event into an
  // InputEventMouseButton, the autoload raycasts through the pointer and pushes the
  // collider it hits. The JS-only tier records the same click as `pointer_click`.
  const canvas = page.locator("#godotCanvas");
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();

  const seen = await waitForEventTypes(request, sessionId, REQUIRED, 60_000);
  for (const type of REQUIRED) {
    expect(seen, `godot export should capture ${type}`).toContain(type);
  }
  console.log(`[godot-export] captured event types: ${[...seen].sort().join(", ")}`);
  const events = await readSessionEvents(request, sessionId);

  // --- session provenance: the godot connector with its native (right-handed) frame ---
  const start = events.find((e) => e.type === "session_start") as unknown as
    | { connector?: { name?: string; coordinateSystem?: { handedness?: string; upAxis?: string } } }
    | undefined;
  expect(start?.connector?.name).toBe("godot");
  expect(start?.connector?.coordinateSystem?.handedness).toBe("right");
  expect(start?.connector?.coordinateSystem?.upAxis).toBe("y");

  // --- camera_sample: the autoload's pose, Z-negated to the canonical frame ---
  const pose = events.find((e) => e.type === "camera_sample") as unknown as
    { position?: number[]; direction?: number[]; fov?: number } | undefined;
  expect(pose?.position, "pose carries a position").toHaveLength(3);
  expect(pose!.position![0]).toBeCloseTo(CAMERA_POS[0], 3);
  expect(pose!.position![1]).toBeCloseTo(CAMERA_POS[1], 3);
  expect(pose!.position![2], "Godot z=+6 → canonical z=-6").toBeCloseTo(-CAMERA_POS[2], 3);
  expect(pose!.direction![2], "Godot forward -Z → canonical +Z").toBeCloseTo(1, 3);
  // Camera3D.fov is 75° vertical by default; the shim sends radians.
  expect(pose!.fov).toBeCloseTo((75 * Math.PI) / 180, 2);

  // --- mesh_interaction: the physics raycast named the developer's node ---
  const pick = events.find((e) => e.type === "mesh_interaction") as unknown as
    { mesh?: string; kind?: string; point?: number[] } | undefined;
  expect(pick?.mesh, "pick carries the StaticBody3D name the ray hit").toBe("Crate");
  expect(pick?.kind).toBe("pick");
  expect(pick?.point, "pick carries a world hit point").toHaveLength(3);
  expect(Math.abs(pick!.point![0]), "hit is on the camera axis").toBeLessThan(0.15);
  expect(pick!.point![1]).toBeCloseTo(1.5, 0);
  expect(pick!.point![2], "Godot hit z=+0.5 → canonical z=-0.5").toBeCloseTo(-CRATE_FRONT_Z, 1);

  // --- frame_perf from the engine's own Engine.get_frames_per_second() ---
  const perf = events.filter((e) => e.type === "frame_perf") as unknown as { fps?: number }[];
  expect(perf.length).toBeGreaterThan(0);
  expect(perf.every((p) => typeof p.fps === "number" && p.fps >= 0)).toBe(true);

  // --- scene proxy: main.gd opted the props in and pushed once; Z is negated ---
  const proxy = await page.evaluate(() => window.__godotExport?.sceneProxy);
  expect(proxy, "the shim's push_scene_proxy() reached the connector").toBeTruthy();
  const names = proxy!.meshes.map((n) => n.name).sort();
  expect(names).toEqual(["CrateMesh", "OrbMesh"]);
  const orb = proxy!.meshes.find((n) => n.name === "OrbMesh")!;
  // Godot z ∈ [-1.5, -0.5] → canonical z ∈ [0.5, 1.5] (min/max re-ordered).
  expect(orb.aabb[2]).toBeCloseTo(-ORB_Z_RANGE[1], 2);
  expect(orb.aabb[5]).toBeCloseTo(-ORB_Z_RANGE[0], 2);
  expect(orb.aabb[0]).toBeCloseTo(2.0, 2);
  expect(orb.aabb[3]).toBeCloseTo(3.0, 2);
});
