// A-Frame engine module: the declarative special case. A-Frame is HTML-first and
// loaded from its official CDN (avoids pulling its git-resolved `three-bmfont-text`
// subdependency through the workspace lockfile), so this module injects the CDN
// script, registers the `@uptimizr/aframe` component, and builds the `<a-scene>` into
// the engine container. The `uptimizr` component owns its own client + transport;
// once the scene has loaded and the component has started, that client is surfaced
// as the instance `client` so the shell can stamp the session id (the e2e harness
// reads it back) — every other client-driven section stays hidden via capabilities.

import type { UptimizrClient } from "@uptimizr/sdk-core";

import { type EngineInstance, type EngineModule, type EngineMountContext } from "../engine.js";

const AFRAME_CDN = "https://aframe.io/releases/1.7.1/aframe.min.js";

interface AFrameGlobal {
  registerComponent(name: string, def: unknown): void;
}

/** The slice of an A-Frame entity we read to reach the `uptimizr` component's client. */
interface UptimizrSceneElement extends Element {
  components?: { uptimizr?: { _uptimizrClient?: UptimizrClient | null } };
}

/**
 * Resolve the client the `uptimizr` component created. The component starts on the
 * scene's `loaded` / `camera-set-active` event, so poll briefly after mount rather
 * than racing its listener; resolves `null` if it never starts (the shell then
 * falls back to the connection/status-only UI).
 */
function waitForComponentClient(
  sceneEl: UptimizrSceneElement,
  timeoutMs = 10_000,
): Promise<UptimizrClient | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const client = sceneEl.components?.uptimizr?._uptimizrClient ?? null;
      if (client) return resolve(client);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function loadAframe(): Promise<void> {
  const existing = (window as unknown as { AFRAME?: AFrameGlobal }).AFRAME;
  if (existing) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = AFRAME_CDN;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load A-Frame from CDN."));
    document.head.appendChild(script);
  });
}

// A-Frame entities don't name their three.js mesh by default, so mesh picks would
// arrive without an object name. This component copies the entity id onto
// `object3D.name` once the mesh exists, so captured hit names are meaningful.
function registerNamedMesh(aframe: AFrameGlobal): void {
  aframe.registerComponent("named-mesh", {
    init(this: {
      el: {
        id: string;
        getObject3D(t: string): { name: string } | undefined;
        addEventListener(t: string, h: () => void): void;
      };
    }) {
      const apply = (): void => {
        const mesh = this.el.getObject3D("mesh");
        if (mesh) mesh.name = this.el.id;
      };
      if (this.el.getObject3D("mesh")) apply();
      else this.el.addEventListener("object3dset", apply);
    },
  });
}

const SCENE_MARKUP = `
  <a-scene background="color: #0b0e14" embedded style="position:fixed; inset:0;">
    <a-entity light="type: hemisphere; intensity: 1.0; color: #ffffff; groundColor: #303a4a"></a-entity>
    <a-entity light="type: directional; intensity: 0.7" position="5 10 7"></a-entity>

    <a-box id="box-0" named-mesh position="-3.2 1 -4" color="#e64d4d"></a-box>
    <a-box id="box-1" named-mesh position="0 1 -4" color="#4db4e6"></a-box>
    <a-box id="box-2" named-mesh position="3.2 1 -4" color="#66d97f"></a-box>

    <a-plane id="ground" named-mesh rotation="-90 0 0" width="24" height="24" color="#212838"></a-plane>

    <a-entity camera look-controls wasd-controls position="0 1.6 4">
      <a-cursor color="#22d3ee"></a-cursor>
    </a-entity>

    <a-entity laser-controls="hand: right"></a-entity>
    <a-entity laser-controls="hand: left"></a-entity>
  </a-scene>
`;

async function mount(ctx: EngineMountContext): Promise<EngineInstance> {
  ctx.onStatus("loading A-Frame…");
  await loadAframe();

  const aframe = (window as unknown as { AFRAME?: AFrameGlobal }).AFRAME;
  if (!aframe) throw new Error("A-Frame global unavailable after CDN load.");

  // Registers the `uptimizr` component on AFRAME (must run after the global exists).
  await import("@uptimizr/aframe");
  registerNamedMesh(aframe);

  ctx.container.innerHTML = SCENE_MARKUP;
  const sceneEl = ctx.container.querySelector("a-scene");
  if (!sceneEl) throw new Error("Failed to build A-Frame scene.");

  // Capture starts when A-Frame initializes the component (XR is on by default).
  sceneEl.setAttribute(
    "uptimizr",
    `projectId: ${ctx.projectId}; collector: ${ctx.collectorUrl}; sceneId: ${ctx.sceneId}`,
  );

  const capturing = `capturing → ${ctx.collectorUrl} (project: ${ctx.projectId})`;
  sceneEl.addEventListener("loaded", () => ctx.onStatus(capturing));
  sceneEl.addEventListener("enter-vr", () =>
    ctx.onStatus("in VR — controller / gaze rays are being captured"),
  );
  sceneEl.addEventListener("exit-vr", () => ctx.onStatus(capturing));

  const client = await waitForComponentClient(sceneEl as UptimizrSceneElement);

  return {
    client,
    flashMesh() {
      // Declarative scene; no imperative flash.
    },
    dispose() {
      ctx.container.innerHTML = "";
    },
  };
}

export const engine: EngineModule = {
  id: "aframe",
  label: "A-Frame (WebXR)",
  captureFeatures: [],
  capabilities: {
    sharedCanvas: false,
    capturePanel: false,
    sceneSwitch: false,
    walkable: false,
    cursorOverlay: false,
    inputSource: false,
    replay: false,
    heatmap: false,
    sceneProxy: false,
  },
  mount,
};
