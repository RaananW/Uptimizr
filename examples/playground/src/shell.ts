// The shared playground shell: it owns every piece of DOM and UX that used to be
// copy-pasted across the five per-engine playgrounds — the engine selector,
// collector connection indicator, delivery-confirming transport, capture-toggle
// panel, scene switcher, input-source readout, on-canvas cursor overlay, and the
// replay / heatmap / scene-proxy controls. It is written once and adapts to the
// selected engine through its declared {@link EngineCapabilities}.

import type { Transport } from "@uptimizr/sdk-core";
import { ReplayPlayer, fetchSessionEvents } from "@uptimizr/replay";

import {
  ENGINE_CHOICES,
  isEngineId,
  type CameraMode,
  type EngineId,
  type EngineInstance,
  type EngineModule,
  type PointerKind,
} from "./engine.js";
import sceneProjectBindings from "virtual:uptimizr-scene-projects";
import {
  DEFAULT_SCENE_ID,
  SCENES,
  enginesForScene,
  getScene,
  type SceneDefinition,
} from "./scenes/catalog.js";

// --- Configuration (Vite env, all optional for local dev) ---------------------
const COLLECTOR_URL = (import.meta.env.VITE_COLLECTOR_URL as string) ?? "http://localhost:4318";
const PROJECT_ID = (import.meta.env.VITE_PROJECT_ID as string) ?? "demo";
const API_KEY = (import.meta.env.VITE_API_KEY as string) ?? "";
// First-person / walkable sessions go to their OWN project so viewer (arc-rotate)
// and first-person analytics stay separate (ADR 0026) — `pnpm db:seed` provisions
// both. Falls back to the viewer project when no walkable project is configured
// (e.g. the e2e harness, which exercises both modes within one project to test the
// camera-mode filter).
const WALKABLE_PROJECT_ID = (import.meta.env.VITE_PROJECT_ID_WALKABLE as string) || PROJECT_ID;
const WALKABLE_API_KEY = (import.meta.env.VITE_API_KEY_WALKABLE as string) || API_KEY;

const ENGINE_STORAGE_KEY = "uptimizr.playground.engine";
const SCENE_STORAGE_KEY = "uptimizr.playground.scene";
const PANEL_OPEN_STORAGE_KEY = "uptimizr.playground.panelOpen";

function requireElement<T extends Element>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) throw new Error(`#${id} is missing or not a ${ctor.name}`);
  return el;
}

function setHidden(id: string, hidden: boolean): void {
  const el = document.getElementById(id);
  if (el) el.hidden = hidden;
}

/** Resolve the active engine from `?engine=` (preferred) then localStorage. */
export function resolveEngineId(): EngineId | null {
  const fromUrl = new URLSearchParams(location.search).get("engine");
  if (isEngineId(fromUrl)) return fromUrl;
  let fromStore: string | null = null;
  try {
    fromStore = localStorage.getItem(ENGINE_STORAGE_KEY);
  } catch {
    /* ignore storage failure */
  }
  return isEngineId(fromStore) ? fromStore : null;
}

/**
 * Resolve the active scene from `?scene=` (preferred), then the `?camera=`
 * back-compat alias (maps to the matching built-in scene), then localStorage,
 * then the catalog default. The scene fixes the camera mode and the collector
 * project (one project per scene).
 */
export function resolveActiveScene(): SceneDefinition {
  const params = new URLSearchParams(location.search);
  const direct = getScene(params.get("scene"));
  if (direct) return direct;
  // Back-compat: `?camera=viewer|first-person` selects the matching built-in scene.
  const camera = params.get("camera");
  if (camera === "first-person" || camera === "viewer") {
    const match = SCENES.find((s) => s.builtin && s.cameraMode === camera);
    if (match) return match;
  }
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(SCENE_STORAGE_KEY);
  } catch {
    /* ignore storage failure */
  }
  const fromStore = getScene(stored);
  if (fromStore) return fromStore;
  const fallback = getScene(DEFAULT_SCENE_ID) ?? SCENES[0];
  if (!fallback) throw new Error("scene catalog is empty");
  return fallback;
}

/**
 * Resolve the engine to render a scene with: `?engine=` (when allowed by the
 * scene), then a persisted choice (when allowed), then the scene's default.
 */
export function resolveEngineForScene(scene: SceneDefinition): EngineId {
  const allowed = enginesForScene(scene);
  const fromUrl = new URLSearchParams(location.search).get("engine");
  if (isEngineId(fromUrl) && allowed.includes(fromUrl)) return fromUrl;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(ENGINE_STORAGE_KEY);
  } catch {
    /* ignore storage failure */
  }
  if (isEngineId(stored) && allowed.includes(stored)) return stored;
  return scene.defaultEngine;
}

/** Resolve the collector project (id + key) bound to a scene — one per scene. */
function resolveSceneProject(scene: SceneDefinition): { projectId: string; apiKey: string } {
  const bound = sceneProjectBindings[scene.id];
  if (bound?.projectId) return bound;
  // Fallback to the env-configured viewer/walkable projects (e2e + first-run).
  return scene.cameraMode === "first-person"
    ? { projectId: WALKABLE_PROJECT_ID, apiKey: WALKABLE_API_KEY }
    : { projectId: PROJECT_ID, apiKey: API_KEY };
}

/**
 * Populate the scene `<select>` and persist + reload on change. Switching reloads
 * with `?scene=<id>` and drops `?engine`/`?camera` so the new scene resets to its
 * own default engine + fixed camera mode. Hidden when only one scene exists.
 */
export function wireSceneSelector(activeSceneId: string): void {
  const select = requireElement("sceneSelect", HTMLSelectElement);
  for (const scene of SCENES) {
    const option = document.createElement("option");
    option.value = scene.id;
    option.textContent = scene.label;
    if (scene.id === activeSceneId) option.selected = true;
    select.append(option);
  }
  const line = document.getElementById("sceneSelectLine");
  if (line) line.hidden = SCENES.length <= 1;
  const descEl = document.getElementById("sceneDescription");
  if (descEl) descEl.textContent = getScene(activeSceneId)?.description ?? "";
  select.addEventListener("change", () => {
    const next = select.value;
    try {
      localStorage.setItem(SCENE_STORAGE_KEY, next);
    } catch {
      /* ignore storage failure */
    }
    const url = new URL(location.href);
    url.searchParams.set("scene", next);
    url.searchParams.delete("engine");
    url.searchParams.delete("camera");
    location.href = url.toString();
  });
}

/**
 * Populate the engine `<select>` (constrained to the scene's engines) and persist
 * + reload on change. Switching reloads with `?engine=<id>&scene=<sceneId>` so the
 * dynamic `import()` pulls **only** the selected engine's chunk. Hidden when the
 * scene is bound to a single engine.
 */
export function wireEngineSelector(active: EngineId, scene: SceneDefinition): void {
  const select = requireElement("engineSelect", HTMLSelectElement);
  const allowed = enginesForScene(scene);
  for (const choice of ENGINE_CHOICES) {
    if (!allowed.includes(choice.id)) continue;
    const option = document.createElement("option");
    option.value = choice.id;
    option.textContent = choice.label;
    if (choice.id === active) option.selected = true;
    select.append(option);
  }
  const line = document.getElementById("engineLine");
  if (line) line.hidden = allowed.length <= 1;
  select.addEventListener("change", () => {
    const next = select.value;
    try {
      localStorage.setItem(ENGINE_STORAGE_KEY, next);
    } catch {
      /* ignore storage failure */
    }
    const url = new URL(location.href);
    url.searchParams.set("engine", next);
    url.searchParams.set("scene", scene.id);
    location.href = url.toString();
  });
}

/**
 * Wire the topbar "Controls" button to collapse/expand the whole side panel.
 * The panel starts collapsed — every signal is captured by default, so there is
 * rarely anything to touch, and on phones it would otherwise cover the scene.
 * The choice persists to localStorage so a returning user keeps their preference.
 */
export function wirePanelToggle(): void {
  const panel = document.getElementById("panel");
  const toggle = document.getElementById("panelToggle");
  if (!panel || !(toggle instanceof HTMLButtonElement)) return;

  let open = false;
  try {
    open = localStorage.getItem(PANEL_OPEN_STORAGE_KEY) === "1";
  } catch {
    /* ignore storage failure */
  }

  const apply = (next: boolean): void => {
    panel.classList.toggle("collapsed", !next);
    toggle.setAttribute("aria-expanded", String(next));
  };
  apply(open);

  toggle.addEventListener("click", () => {
    open = !open;
    apply(open);
    try {
      localStorage.setItem(PANEL_OPEN_STORAGE_KEY, open ? "1" : "0");
    } catch {
      /* ignore storage failure */
    }
  });
}

/**
 * Reflect the active camera/navigation model (ADR 0026) in the panel. This is a
 * read-only indicator: the camera mode is fixed by the selected scene (you switch
 * it by choosing a different scene), so there is nothing to toggle here.
 */
export function showCameraMode(mode: CameraMode): void {
  const el = document.getElementById("cameraMode");
  if (el) el.textContent = mode;
}

// --- Connection / delivery indicator -----------------------------------------
let deliveredCount = 0;

function setConnection(state: "ok" | "bad" | "unknown", text: string): void {
  const dot = requireElement("connDot", HTMLElement);
  dot.classList.remove("ok", "bad");
  if (state !== "unknown") dot.classList.add(state);
  requireElement("connText", HTMLElement).textContent = text;
}

async function pingCollector(): Promise<void> {
  try {
    const res = await fetch(`${COLLECTOR_URL}/health`);
    if (res.ok) setConnection("ok", `Collector: connected (${COLLECTOR_URL})`);
    else setConnection("bad", `Collector: error ${res.status}`);
  } catch {
    setConnection("bad", `Collector: unreachable (${COLLECTOR_URL})`);
  }
}

/**
 * A fetch transport that confirms delivery: it POSTs the batch, reads the
 * `{ accepted }` count the collector returns, and reports it so the UI can show
 * how many events were actually stored. Returns `false` on any failure so the SDK
 * re-queues the batch for the next flush.
 */
function createReportingTransport(endpoint: string): Transport {
  const url = `${endpoint.replace(/\/$/, "")}/api/v1/collect`;
  const deliveredEl = requireElement("delivered", HTMLElement);
  return {
    async send(batch) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
        });
        if (!res.ok) {
          setConnection("bad", `Collector: rejected batch (${res.status})`);
          return false;
        }
        const body = (await res.json()) as { accepted?: number };
        deliveredCount += body.accepted ?? batch.events.length;
        deliveredEl.textContent = String(deliveredCount);
        setConnection("ok", `Collector: connected (${COLLECTOR_URL})`);
        return true;
      } catch {
        setConnection("bad", `Collector: unreachable (${COLLECTOR_URL})`);
        return false;
      }
    },
  };
}

// --- On-canvas cursor overlay ------------------------------------------------
function makeCursorOverlay(canvas: HTMLCanvasElement): {
  showReplayCursor(screen: [number, number], type: PointerKind): void;
} {
  const cursorEl = requireElement("cursor", HTMLElement);
  const cursorPulseEl = requireElement("cursorPulse", HTMLElement);
  cursorEl.hidden = false;
  cursorPulseEl.hidden = false;

  function moveCursorTo(clientX: number, clientY: number): void {
    cursorEl.style.transform = `translate(${clientX}px, ${clientY}px)`;
    cursorPulseEl.style.transform = `translate(${clientX}px, ${clientY}px)`;
    cursorEl.classList.add("visible");
  }
  function pulseCursor(): void {
    cursorPulseEl.classList.remove("pulse");
    void cursorPulseEl.offsetWidth; // force reflow so rapid repeats re-animate
    cursorPulseEl.classList.add("pulse");
  }

  // Live pointer: drive the overlay straight from the DOM events on the canvas.
  // While the canvas holds a pointer lock (FPS / walkable scenes) the OS hides the
  // real cursor and `pointermove` reports relative deltas, not page coordinates —
  // so the overlay would freeze in place and look stuck (three.js, unlike
  // PlayCanvas, doesn't drop a `pointerleave`). Suppress the overlay while locked
  // and let it reappear on the next move after the lock is released.
  let pointerLocked = false;
  canvas.addEventListener("pointermove", (e) => {
    if (pointerLocked) return;
    cursorEl.classList.remove("replay");
    moveCursorTo(e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerdown", (e) => {
    if (pointerLocked) return;
    cursorEl.classList.remove("replay");
    moveCursorTo(e.clientX, e.clientY);
    cursorEl.classList.add("down");
  });
  canvas.addEventListener("pointerup", () => {
    if (pointerLocked) return;
    cursorEl.classList.remove("down");
    pulseCursor();
  });
  canvas.addEventListener("pointerleave", () => {
    cursorEl.classList.remove("visible", "down");
  });
  document.addEventListener("pointerlockchange", () => {
    pointerLocked = document.pointerLockElement === canvas;
    if (pointerLocked) {
      cursorEl.classList.remove("visible", "down");
      cursorPulseEl.classList.remove("pulse");
    }
  });

  let replayClickReset: ReturnType<typeof setTimeout> | undefined;
  function showReplayCursor(screen: [number, number], type: PointerKind): void {
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + screen[0] * rect.width;
    const clientY = rect.top + screen[1] * rect.height;
    cursorEl.classList.add("replay");
    moveCursorTo(clientX, clientY);
    if (type === "pointer_down") {
      clearTimeout(replayClickReset);
      cursorEl.classList.add("down");
    } else if (type === "pointer_up") {
      cursorEl.classList.remove("down");
      pulseCursor();
    } else if (type === "pointer_click") {
      cursorEl.classList.add("down");
      pulseCursor();
      clearTimeout(replayClickReset);
      replayClickReset = setTimeout(() => cursorEl.classList.remove("down"), 180);
    }
  }
  return { showReplayCursor };
}

// --- Pointer-lock crosshair (walkable scenes) --------------------------------
// Under pointer lock the OS cursor is hidden and clicks pick whatever the camera
// looks at (center of the viewport). A center reticle shows where you're aiming
// and flashes amber when a pick registers — the visible confirmation that
// locked clicks are being captured (the lock-engaging click itself is suppressed
// by the walkable demos' overlay).
function makeCrosshair(canvas: HTMLCanvasElement): { pulse(): void } {
  const crosshairEl = requireElement("crosshair", HTMLElement);
  const onLockChange = (): void => {
    crosshairEl.hidden = document.pointerLockElement !== canvas;
  };
  document.addEventListener("pointerlockchange", onLockChange);
  onLockChange();
  return {
    pulse(): void {
      if (crosshairEl.hidden) return;
      crosshairEl.classList.remove("hit");
      void crosshairEl.offsetWidth; // force reflow so rapid repeats re-animate
      crosshairEl.classList.add("hit");
    },
  };
}

// --- Capture configuration (checkbox side panel) -----------------------------
// Which signals the SDK records is an init-time decision (the collector wires its
// observers once at start), so the panel persists each toggle to localStorage and
// reloads to re-initialize the session with the new config.
function readCaptureState(engine: EngineModule): Record<string, boolean> {
  const storageKey = `uptimizr.playground.${engine.id}.capture`;
  const state: Record<string, boolean> = {};
  for (const f of engine.captureFeatures) state[f.key] = f.default;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, unknown>;
      for (const f of engine.captureFeatures) {
        if (typeof saved[f.key] === "boolean") state[f.key] = saved[f.key] as boolean;
      }
    }
  } catch {
    /* ignore malformed storage */
  }
  return state;
}

function buildCapturePanel(engine: EngineModule, state: Record<string, boolean>): void {
  const storageKey = `uptimizr.playground.${engine.id}.capture`;
  const captureConfigEl = requireElement("captureConfig", HTMLElement);
  const captureConfigNote = requireElement("captureConfigNote", HTMLElement);
  for (const feature of engine.captureFeatures) {
    const label = document.createElement("label");
    label.className = "capture-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state[feature.key] ?? feature.default;
    checkbox.addEventListener("change", () => {
      state[feature.key] = checkbox.checked;
      try {
        localStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        /* ignore storage failure */
      }
      captureConfigNote.textContent = "Reloading to apply capture changes…";
      setTimeout(() => location.reload(), 250);
    });
    label.append(checkbox, document.createTextNode(` ${feature.label}`));
    captureConfigEl.append(label);
  }
}

/**
 * Boot the playground for the chosen engine: wire the connection indicator,
 * dynamic-import nothing here (the caller passes the already-loaded module), build
 * the transport + capture config, mount the engine, then reveal only the panel
 * sections the engine supports and wire scene switching, replay, heatmap, proxy.
 */
export async function runPlayground(engine: EngineModule, scene: SceneDefinition): Promise<void> {
  const status = requireElement("status", HTMLElement);
  const canvas = requireElement("renderCanvas", HTMLCanvasElement);
  const container = requireElement("engineRoot", HTMLElement);
  const caps = engine.capabilities;

  void pingCollector();

  // Show the right render surface for this engine.
  canvas.hidden = !caps.sharedCanvas;
  container.hidden = caps.sharedCanvas;

  const cursor = caps.cursorOverlay ? makeCursorOverlay(canvas) : null;
  // Walkable scenes run under pointer lock: show a center crosshair that flashes
  // on each registered pick.
  const crosshair = caps.walkable ? makeCrosshair(canvas) : null;

  const captureState = readCaptureState(engine);
  // Keyboard capture is allowlist-only (ADR 0023, ADR 0003): only the keys mapped
  // here are ever recorded, each as a semantic `input_action`. Defaults cover the
  // movement keys every walkable demo uses — WASD + arrows — plus the demo's own
  // camera-cycle / jump bindings. Hosts override `keyBindings` to track their own.
  const keyBindings =
    captureState.keyboard != null && captureState.keyboard
      ? {
          KeyW: "move-forward",
          ArrowUp: "move-forward",
          KeyS: "move-back",
          ArrowDown: "move-back",
          KeyA: "move-left",
          ArrowLeft: "move-left",
          KeyD: "move-right",
          ArrowRight: "move-right",
          Space: "jump",
          KeyN: "next-camera",
        }
      : undefined;

  // Camera/navigation model (ADR 0026) is fixed by the scene. Engines without the
  // `walkable` capability always run the viewer scene; we surface the active mode
  // as a read-only indicator (you change it by picking a different scene).
  const cameraMode: CameraMode = caps.walkable ? scene.cameraMode : "viewer";
  showCameraMode(cameraMode);

  // One project per scene (the scene fixes the camera mode). Resolve the project +
  // key bound to this scene (registry binding, falling back to the env projects).
  const { projectId: activeProjectId, apiKey: activeApiKey } = resolveSceneProject(scene);
  requireElement("projectId", HTMLElement).textContent = activeProjectId;

  // Live click counter (local) — the engine reports each demo box pick.
  let clickCount = 0;
  const clicksEl = requireElement("clicks", HTMLElement);

  // Input-source readout (ADR 0011): mirror the live pointer type.
  if (caps.inputSource) {
    const lastSourceEl = requireElement("lastSource", HTMLElement);
    canvas.addEventListener("pointerdown", (e) => {
      lastSourceEl.textContent = e.pointerType || "—";
    });
  }

  let instance: EngineInstance;
  try {
    instance = await engine.mount({
      canvas,
      container,
      collectorUrl: COLLECTOR_URL,
      projectId: activeProjectId,
      apiKey: activeApiKey,
      transport: createReportingTransport(COLLECTOR_URL),
      capture: captureState,
      sceneId: scene.id,
      cameraMode,
      ...(keyBindings ? { keyBindings } : {}),
      onBoxPick: () => {
        clickCount += 1;
        clicksEl.textContent = String(clickCount);
        crosshair?.pulse();
      },
      onStatus: (text) => {
        status.textContent = text;
      },
    });
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : "Failed to start the engine.";
    return;
  }

  const client = instance.client;

  // The declarative A-Frame path owns its own client; only the connection
  // indicator + status apply. Hide every client-dependent section.
  const hasClient = client != null;
  setHidden("metaDetails", !hasClient);
  setHidden("sessionSection", !hasClient);
  setHidden("samplingLine", !hasClient);
  setHidden("sourceSection", !caps.inputSource);
  setHidden("captureDetails", !(hasClient && caps.capturePanel));
  setHidden("captureConfig", !(hasClient && caps.capturePanel));
  setHidden("captureConfigNote", !(hasClient && caps.capturePanel));
  setHidden("sceneSection", !(hasClient && caps.sceneSwitch));
  setHidden("replaySection", !(hasClient && caps.replay && instance.createReplayDriver));
  setHidden("heatmapSection", !(hasClient && caps.heatmap && instance.showHeatmap));
  setHidden("proxySection", !(hasClient && caps.sceneProxy && instance.registerSceneProxy));
  setHidden("heatmapStatus", !(hasClient && (caps.heatmap || caps.sceneProxy)));

  if (!client) return; // A-Frame declarative path: nothing further to wire.

  requireElement("sessionId", HTMLElement).textContent = client.sessionId;

  if (caps.capturePanel) buildCapturePanel(engine, captureState);

  // --- Scene/area switching (ADR 0010) ---------------------------------------
  let currentScene = scene.id;
  if (caps.sceneSwitch) {
    const currentSceneEl = requireElement("currentScene", HTMLElement);
    currentSceneEl.textContent = currentScene;
    // The lobby/gallery sub-area switcher only applies to the built-in viewer
    // scene; first-person is a single traversable area, and custom scenes don't
    // ship the lobby/gallery sub-areas — hide the buttons in those cases.
    const firstPerson = cameraMode === "first-person";
    const subAreas = !firstPerson && scene.builtin && scene.id === "lobby";
    setHidden("sceneSwitcher", !subAreas);
    if (subAreas) {
      const switchScene = (sceneId: string): void => {
        if (sceneId === currentScene) return;
        client.setScene(sceneId);
        currentScene = sceneId;
        currentSceneEl.textContent = sceneId;
      };
      for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-scene]")) {
        button.addEventListener("click", () => switchScene(button.dataset.scene ?? "lobby"));
      }
    }
  }

  // --- Replay a captured session in THIS scene -------------------------------
  if (caps.replay && instance.createReplayDriver) {
    const createReplayDriver = instance.createReplayDriver.bind(instance);
    const replaySession = async (sessionId: string): Promise<void> => {
      if (!activeApiKey) {
        status.textContent = "Set VITE_API_KEY to enable replay.";
        return;
      }
      if (!sessionId) {
        status.textContent = "Enter a session id to replay.";
        return;
      }
      status.textContent = `Loading session ${sessionId}…`;
      try {
        const events = await fetchSessionEvents({
          endpoint: COLLECTOR_URL,
          apiKey: activeApiKey,
          sessionId,
        });
        const driver = createReplayDriver({
          showCursor: (screen, type) => cursor?.showReplayCursor(screen, type),
          setStatus: (text) => {
            status.textContent = text;
          },
        });
        const player = new ReplayPlayer(events, driver, {
          speed: 1,
          onComplete: () => {
            status.textContent = `Replay complete (${events.length} events).`;
          },
        });
        player.play();
        status.textContent = `Replaying ${events.length} events — watch the camera move and boxes flash…`;
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : "Replay failed.";
      }
    };

    const replayButton = requireElement("replayButton", HTMLButtonElement);
    const replayInput = requireElement("replayInput", HTMLInputElement);
    replayButton.addEventListener("click", () => void replaySession(replayInput.value.trim()));

    // Flush the live session, then replay it by its own id — the quickest way to
    // confirm the full round-trip (capture → collector → DB → replay).
    const replayCurrentButton = requireElement("replayCurrentButton", HTMLButtonElement);
    replayCurrentButton.addEventListener("click", () => {
      void (async () => {
        status.textContent = "Flushing current session…";
        await client.flush();
        await new Promise((resolve) => setTimeout(resolve, 400));
        await replaySession(client.sessionId);
      })();
    });
  }

  // --- 3D heatmap overlay (Babylon only, Tier 0) -----------------------------
  const heatmapStatus = document.getElementById("heatmapStatus");
  if (caps.heatmap && instance.showHeatmap && heatmapStatus) {
    const showHeatmap = instance.showHeatmap.bind(instance);
    const heatmapButton = requireElement("heatmapButton", HTMLButtonElement);
    let heatmap: { dispose(): void } | null = null;
    heatmapButton.addEventListener("click", () => {
      void (async () => {
        if (!activeApiKey) {
          heatmapStatus.textContent = "Set VITE_API_KEY to load the heatmap.";
          return;
        }
        if (heatmap) {
          heatmap.dispose();
          heatmap = null;
          heatmapButton.textContent = "Show 3D heatmap overlay";
          heatmapStatus.textContent = "Heatmap overlay hidden.";
          return;
        }
        heatmapStatus.textContent = `Loading heatmap for "${currentScene}"…`;
        try {
          heatmap = await showHeatmap(currentScene);
          heatmapButton.textContent = "Hide 3D heatmap overlay";
          heatmapStatus.textContent = `Heatmap overlay shown for "${currentScene}".`;
        } catch (err) {
          heatmapStatus.textContent = err instanceof Error ? err.message : "Heatmap failed.";
        }
      })();
    });
  }

  // --- Scene proxy registration (ADR 0014) -----------------------------------
  if (caps.sceneProxy && instance.registerSceneProxy && heatmapStatus) {
    const registerSceneProxy = instance.registerSceneProxy.bind(instance);
    const runProxyScan = async (): Promise<void> => {
      if (!activeApiKey) {
        heatmapStatus.textContent = "Set VITE_API_KEY to register the scene proxy.";
        return;
      }
      heatmapStatus.textContent = `Scanning "${currentScene}" scene proxy…`;
      try {
        const meshCount = await registerSceneProxy(currentScene);
        heatmapStatus.textContent = `Registered proxy for "${currentScene}" (${meshCount} meshes).`;
      } catch (err) {
        heatmapStatus.textContent = err instanceof Error ? err.message : "Proxy scan failed.";
      }
    };
    const registerProxyButton = requireElement("registerProxyButton", HTMLButtonElement);
    registerProxyButton.addEventListener("click", () => void runProxyScan());
    // Auto-register the scene proxy on mount so session replay and the 3D panels
    // (which need the scene representation, ADR 0014) always render without a
    // manual click. Skipped when no API key is configured (standalone dev).
    if (activeApiKey) void runProxyScan();
  }
}
