import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

/**
 * The `<script>`-tag bundles against **real engines** on a page with no bundler.
 *
 * Every connector's `dist/*.global.js` binds its engine late, to a browser global
 * (`scripts/bundle-global.mjs`). Stubs cannot prove that: this spec loads the built
 * bundles next to the real three.js, PlayCanvas, Babylon Lite and A-Frame builds,
 * then checks that a session really starts and that engine classes really construct.
 *
 * Nothing here talks to the suite's servers. The page lives on a fake origin answered
 * by `page.route`, so the browser never reaches the network: anything else it asks
 * for is aborted and fails the test.
 *
 * A-Frame is the one engine not in `node_modules`: its git-resolved `three-bmfont-text`
 * dependency is deliberately kept out of the lockfile (see `src/engines/aframe.ts`).
 * As in `aframe.spec.ts`, the Node side fetches the official build once and holds it
 * in memory, and the test skips if that fetch fails.
 */

const ORIGIN = "https://uptimizr.test";
const NO_WEBGPU = "No WebGPU adapter on this machine, so real Babylon Lite cannot start";
const AFRAME_BUILD = "https://aframe.io/releases/1.7.1/aframe.min.js";

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../../../oss/packages");
const modules = resolve(here, "../node_modules");

/** What the fake origin serves, by path. */
const FILES: Record<string, string> = {
  "/uptimizr-three.global.js": `${packages}/sdk-three/dist/uptimizr-three.global.js`,
  "/uptimizr-aframe.global.js": `${packages}/sdk-aframe/dist/uptimizr-aframe.global.js`,
  "/uptimizr-playcanvas.global.js": `${packages}/sdk-playcanvas/dist/uptimizr-playcanvas.global.js`,
  "/uptimizr-babylon-lite.global.js": `${packages}/sdk-babylon-lite/dist/uptimizr-babylon-lite.global.js`,
  "/vendor/three/three.module.js": `${modules}/three/build/three.module.js`,
  "/vendor/three/three.core.js": `${modules}/three/build/three.core.js`,
  "/vendor/playcanvas.min.js": `${modules}/playcanvas/build/playcanvas.min.js`,
  "/vendor/babylon-lite.js": `${modules}/@babylonjs/lite/dist/index.js`,
};

const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".html": "text/html",
};

let aframeBuild: Promise<Buffer | null> | undefined;
function fetchAframe(): Promise<Buffer | null> {
  aframeBuild ??= fetch(AFRAME_BUILD)
    .then(async (res) => (res.ok ? Buffer.from(await res.arrayBuffer()) : null))
    .catch(() => null);
  return aframeBuild;
}

interface CapturedEvent {
  type: string;
  connector?: { name?: string; version?: string };
}

declare global {
  interface Window {
    __ready?: boolean;
    __noWebgpu?: boolean;
    __batches?: { events: CapturedEvent[] }[];
    __client?: { sessionId: string; flush(): Promise<unknown> };
    /** Starts tracking with the real scene; the page defines it. */
    __start?: () => void;
    /** Sets the engine global, on pages that hold it back. */
    __expose?: () => void;
    /** A value only the real engine can produce, to compare with the session's. */
    __engineVersion?: () => string;
    __scan?: () => { meshes: { name?: string; bounds?: number[] }[] };
    Uptimizr?: unknown;
    UptimizrAframe?: { registerUptimizrComponent?: unknown };
  }
}

/** Options every page passes to `trackScene`: delivery lands in `window.__batches`. */
const HARNESS = `<script>
  window.__batches = [];
  window.__options = {
    projectId: "e2e-global-bundle",
    endpoint: ${JSON.stringify(ORIGIN)},
    flushIntervalMs: 50,
    transport: { send: async (batch) => (window.__batches.push(batch), true) },
  };
</script>`;

const CANVAS = `<canvas id="c" width="640" height="480" style="width:640px;height:480px;display:block"></canvas>`;

/** The bundle comes first here, so the engine global is set after it has loaded. */
function threePage(expose: "now" | "later"): string {
  return `<!doctype html><body style="margin:0">${CANVAS}${HARNESS}
    <script src="/uptimizr-three.global.js"></script>
    <script type="module">
      import * as THREE from "/vendor/three/three.module.js";
      window.__expose = () => { window.THREE = THREE; };
      ${expose === "now" ? "window.__expose();" : ""}
      const canvas = document.getElementById("c");
      const renderer = new THREE.WebGLRenderer({ canvas });
      renderer.setSize(640, 480, false);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, 640 / 480, 0.1, 100);
      camera.position.z = 5;
      const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
      box.name = "global-box";
      scene.add(box);
      renderer.render(scene, camera);
      window.__start = () => {
        window.__client = Uptimizr.trackScene(scene, camera, renderer, window.__options);
      };
      window.__scan = () => Uptimizr.scanSceneProxy(scene, { sceneId: "global" });
      window.__engineVersion = () => THREE.REVISION;
      window.__ready = true;
    </script>`;
}

/** The classic script order, engine first, with `pc` removable to prove the error. */
function playcanvasPage(expose: "now" | "later"): string {
  return `<!doctype html><body style="margin:0">${CANVAS}${HARNESS}
    <script src="/vendor/playcanvas.min.js"></script>
    <script src="/uptimizr-playcanvas.global.js"></script>
    <script>
      const engine = window.pc;
      window.__expose = () => { window.pc = engine; };
      const canvas = document.getElementById("c");
      const app = new engine.Application(canvas, {});
      app.setCanvasFillMode(engine.FILLMODE_NONE);
      const camera = new engine.Entity("camera");
      camera.addComponent("camera", { clearColor: new engine.Color(0, 0, 0) });
      camera.setPosition(0, 0, 5);
      app.root.addChild(camera);
      const box = new engine.Entity("global-box");
      box.addComponent("render", { type: "box" });
      box.setLocalScale(2, 2, 2);
      app.root.addChild(box);
      app.once("postrender", () => {
        ${expose === "later" ? "delete window.pc;" : ""}
        window.__start = () => {
          window.__client = Uptimizr.trackScene(app, camera, window.__options);
        };
        window.__engineVersion = () => engine.version;
        window.__ready = true;
      });
      app.start();
    </script>`;
}

/** Lite is ESM-only and WebGPU-only, so this page reports when there is no adapter. */
function litePage(expose: "now" | "later"): string {
  return `<!doctype html><body style="margin:0">${CANVAS}${HARNESS}
    <script src="/uptimizr-babylon-lite.global.js"></script>
    <script type="module">
      import * as BabylonLite from "/vendor/babylon-lite.js";
      window.__expose = () => { window.BabylonLite = BabylonLite; };
      ${expose === "now" ? "window.__expose();" : ""}
      if (!(await navigator.gpu?.requestAdapter())) {
        window.__noWebgpu = true;
        throw new Error("no WebGPU adapter");
      }
      const canvas = document.getElementById("c");
      const engine = await BabylonLite.createEngine(canvas);
      const scene = BabylonLite.createSceneContext(engine);
      const camera = BabylonLite.createArcRotateCamera(Math.PI / 2, Math.PI / 2, 6, { x: 0, y: 0, z: 0 });
      scene.camera = camera;
      BabylonLite.addToScene(scene, camera);
      BabylonLite.addToScene(scene, BabylonLite.createHemisphericLight([0, 1, 0], 1));
      const box = BabylonLite.createBox(engine, 2);
      box.name = "global-box";
      box.material = BabylonLite.createStandardMaterial();
      BabylonLite.addToScene(scene, box);
      await BabylonLite.registerScene(scene);
      await BabylonLite.startEngine(engine);
      window.__start = () => {
        window.__client = Uptimizr.trackScene(scene, camera, canvas, window.__options);
      };
      window.__engineVersion = () => BabylonLite.VERSION;
      window.__ready = true;
    </script>`;
}

function aframePage(afterEngine = ""): string {
  return `<!doctype html><head>
      <script src="/vendor/aframe.min.js"></script>
      <script>${afterEngine}</script>
      <script src="/uptimizr-aframe.global.js"></script>
    </head>
    <body>
      <a-scene uptimizr="projectId: e2e-global-bundle; collector: ${ORIGIN}">
        <a-box position="0 1 -3" color="#4db4e6"></a-box>
      </a-scene>
    </body>`;
}

/**
 * Answer the fake origin and refuse everything else. Returns what the page tried to
 * reach, what it reported, and the events posted to the routed collector endpoint.
 */
async function serve(page: Page, html: string) {
  const seen = {
    pageErrors: [] as string[],
    refused: [] as string[],
    collected: [] as CapturedEvent[],
  };
  page.on("pageerror", (err) => seen.pageErrors.push(err.message));

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      seen.refused.push(url.href);
      return route.abort();
    }
    if (url.pathname === "/") {
      return route.fulfill({ body: html, contentType: CONTENT_TYPES[".html"] });
    }
    if (url.pathname === "/api/v1/collect") {
      const batch = JSON.parse(route.request().postData() ?? "{}") as { events?: CapturedEvent[] };
      seen.collected.push(...(batch.events ?? []));
      return route.fulfill({ status: 200, json: { ok: true } });
    }
    if (url.pathname === "/vendor/aframe.min.js") {
      return route.fulfill({
        body: (await fetchAframe()) ?? "",
        contentType: CONTENT_TYPES[".js"],
      });
    }
    const file = FILES[url.pathname];
    if (!file) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      body: readFileSync(file),
      contentType: CONTENT_TYPES[extname(file)],
    });
  });
  return seen;
}

/** Every event delivered to the page's custom transport so far. */
function delivered(page: Page): Promise<CapturedEvent[]> {
  return page.evaluate(() => (window.__batches ?? []).flatMap((batch) => batch.events));
}

async function sessionStart(page: Page): Promise<CapturedEvent> {
  await expect
    .poll(async () => (await delivered(page)).map((e) => e.type))
    .toContain("session_start");
  return (await delivered(page)).find((e) => e.type === "session_start")!;
}

/** `true` once a click at the canvas centre has landed on the named real mesh. */
async function clickHitsBox(page: Page): Promise<void> {
  await page.mouse.move(320, 240);
  await page.mouse.down();
  await page.mouse.up();
  await expect
    .poll(async () => {
      const events = await delivered(page);
      return events.some(
        (e) => e.type === "mesh_interaction" && JSON.stringify(e).includes("global-box"),
      );
    })
    .toBe(true);
}

// Real Babylon Lite needs a WebGPU adapter. Playwright's default headless shell has
// none, but full Chromium (installed alongside it) offers its software rasterizer.
test.use({
  channel: "chromium",
  launchOptions: { args: ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"] },
});

/** Waits for the page's scene; `false` means this machine has no WebGPU adapter. */
async function sceneReady(page: Page): Promise<boolean> {
  await page.waitForFunction(() => window.__ready === true || window.__noWebgpu === true);
  return page.evaluate(() => window.__ready === true);
}

test("[three] the bundle runs against a window.THREE set after it loaded", async ({ page }) => {
  const seen = await serve(page, threePage("now"));
  await page.goto(`${ORIGIN}/`);
  await sceneReady(page);
  expect(seen.pageErrors).toEqual([]);
  expect(await page.evaluate(() => typeof window.Uptimizr)).toBe("object");

  await page.evaluate(() => window.__start!());
  const start = await sessionStart(page);
  expect(start.connector?.name).toBe("three");
  // The primitive comes through the late binding unchanged.
  expect(start.connector?.version).toBe(await page.evaluate(() => window.__engineVersion!()));

  // `new Raycaster()` through the shim, against the page's own scene.
  await clickHitsBox(page);

  // `new Box3()` through the shim: the lazy box measures a real mesh.
  const proxy = await page.evaluate(() => window.__scan!());
  expect(proxy.meshes.map((mesh) => mesh.name)).toContain("global-box");

  expect(seen.pageErrors).toEqual([]);
  expect(seen.refused).toEqual([]);
});

test("[playcanvas] the bundle runs against the classic window.pc", async ({ page }) => {
  const seen = await serve(page, playcanvasPage("now"));
  await page.goto(`${ORIGIN}/`);
  await sceneReady(page);
  expect(seen.pageErrors).toEqual([]);
  expect(await page.evaluate(() => typeof window.Uptimizr)).toBe("object");

  await page.evaluate(() => window.__start!());
  const start = await sessionStart(page);
  expect(start.connector?.name).toBe("playcanvas");
  expect(start.connector?.version).toBe(await page.evaluate(() => window.__engineVersion!()));

  // `new Ray()` / `new Vec3()` through the shim, against the page's own scene.
  await clickHitsBox(page);

  expect(seen.pageErrors).toEqual([]);
  expect(seen.refused).toEqual([]);
});

test("[babylon-lite] the bundle runs against a window.BabylonLite", async ({ page }) => {
  const seen = await serve(page, litePage("now"));
  await page.goto(`${ORIGIN}/`);
  test.skip(!(await sceneReady(page)), NO_WEBGPU);
  expect(seen.pageErrors).toEqual([]);
  expect(await page.evaluate(() => typeof window.Uptimizr)).toBe("object");

  await page.evaluate(() => window.__start!());
  const start = await sessionStart(page);
  expect(start.connector?.name).toBe("babylon-lite");
  expect(start.connector?.version).toBe(await page.evaluate(() => window.__engineVersion!()));

  // `onBeforeRender` runs the frame hook; `createGpuPicker` / `pickAsync` resolve the click.
  await clickHitsBox(page);

  expect(seen.pageErrors).toEqual([]);
  expect(seen.refused).toEqual([]);
});

for (const [name, afterEngine] of [
  ["window.THREE", ""],
  ["AFRAME.THREE alone", "delete globalThis.THREE;"],
] as const) {
  test(`[aframe] the component starts a session through ${name}`, async ({ page }) => {
    test.skip(!(await fetchAframe()), `Could not fetch ${AFRAME_BUILD}`);

    const seen = await serve(page, aframePage(afterEngine));
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => {
      const scene = document.querySelector("a-scene") as unknown as {
        components?: { uptimizr?: { _uptimizrClient?: Window["__client"] } };
      };
      window.__client = scene?.components?.uptimizr?._uptimizrClient ?? undefined;
      return window.__client !== undefined;
    });
    expect(await page.evaluate(() => typeof window.UptimizrAframe)).toBe("object");

    await expect
      .poll(async () => {
        await page.evaluate(() => window.__client!.flush());
        return seen.collected.map((e) => e.type);
      })
      .toContain("session_start");
    const start = seen.collected.find((e) => e.type === "session_start")!;
    expect(start.connector?.name).toBe("aframe");

    expect(seen.pageErrors).toEqual([]);
    expect(seen.refused).toEqual([]);
  });
}

for (const { id, page: html, message } of [
  { id: "three", page: threePage, message: "window.THREE = THREE" },
  { id: "playcanvas", page: playcanvasPage, message: "window.pc = pc" },
  { id: "babylon-lite", page: litePage, message: "window.BabylonLite = BabylonLite" },
]) {
  test(`[${id}] a missing global is a clear error, and setting it later recovers`, async ({
    page,
  }) => {
    const seen = await serve(page, html("later"));
    await page.goto(`${ORIGIN}/`);
    test.skip(!(await sceneReady(page)), NO_WEBGPU);

    // Loading never throws: the bundle is there, only the engine is not.
    expect(seen.pageErrors).toEqual([]);
    expect(await page.evaluate(() => typeof window.Uptimizr)).toBe("object");

    const failure = await page.evaluate(() => {
      try {
        window.__start!();
        return "no error";
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(failure).toContain("not set");
    expect(failure).toContain(message);

    // It failed before the session began, so nothing was sent for a dead integration.
    await page.waitForTimeout(150);
    expect(await delivered(page)).toEqual([]);

    await page.evaluate(() => {
      window.__expose!();
      window.__start!();
    });
    expect((await sessionStart(page)).type).toBe("session_start");
  });
}
