import { describe, expect, it, vi, beforeEach } from "vitest";
import type * as UptimizrThree from "@uptimizr/three";

// A-Frame wraps three.js, so the capture engine is entirely `@uptimizr/three`.
// We stub `trackScene` (it touches real WebGL/DOM) and assert the component wires
// the live scene/camera/renderer, the `aframe` connector provenance, the XR
// collector, and teardown — the A-Frame glue this package actually owns.
const h = vi.hoisted(() => {
  const use = vi.fn();
  const stop = vi.fn(() => Promise.resolve());
  const client = { use, stop, sessionId: "sess_test" };
  use.mockReturnValue(client);
  const trackScene = vi.fn(() => client);
  return { use, stop, client, trackScene };
});

// We stub `trackScene` (it touches real WebGL/DOM) but keep the real `xrCollector`
// (pure, owned by `@uptimizr/three`) so the XR wiring is exercised end-to-end.
vi.mock("@uptimizr/three", async () => {
  const actual = await vi.importActual<typeof UptimizrThree>("@uptimizr/three");
  return { ...actual, trackScene: h.trackScene };
});

import {
  createUptimizrComponent,
  registerUptimizrComponent,
  COMPONENT_NAME,
} from "../component.js";
import type {
  AframeComponentDefinition,
  AframeLike,
  AframeSceneElement,
  UptimizrComponentData,
  UptimizrComponentInstance,
} from "../types.js";

const LIB_VERSION = "1.7.0";

interface FakeSceneEl extends AframeSceneElement {
  listeners: Record<string, Array<(...a: unknown[]) => void>>;
  dispatch(type: string): void;
}

function makeSceneEl(ready: boolean): FakeSceneEl {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const xr = {
    isPresenting: false,
    getSession: () => undefined,
    getController: () => undefined,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const el = {
    object3D: { name: "scene" },
    camera: ready ? { name: "camera" } : undefined,
    renderer: ready ? { name: "renderer", xr } : undefined,
    hasLoaded: ready,
    listeners,
    addEventListener(type: string, handler: (...a: unknown[]) => void) {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener(type: string, handler: (...a: unknown[]) => void) {
      const l = listeners[type];
      if (!l) return;
      const i = l.indexOf(handler);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(type: string) {
      for (const fn of (listeners[type] ?? []).slice()) fn();
    },
  } as unknown as FakeSceneEl;
  (el as { sceneEl: AframeSceneElement }).sceneEl = el;
  return el;
}

function mount(
  def: AframeComponentDefinition,
  el: AframeSceneElement,
  data: Partial<UptimizrComponentData> = {},
): UptimizrComponentInstance {
  const full: UptimizrComponentData = {
    projectId: "proj_demo",
    collector: "http://localhost:4318",
    sampleCameraMs: 0,
    samplePerfMs: 0,
    pointerMoveThrottleMs: 0,
    sceneDescription: "",
    meshVisibility: false,
    hoverDwell: false,
    resourceSample: false,
    gaze: false,
    cameraGesture: true,
    xr: true,
    xrSampleMs: 0,
    disabled: false,
    debug: false,
    ...data,
  };
  // A-Frame copies the definition methods onto the component instance and binds
  // `this`; emulate that so `this._startUptimizr()` / deferred starts resolve.
  const instance = { el, data: full } as UptimizrComponentInstance & {
    init(): void;
    update(oldData: Partial<UptimizrComponentData>): void;
    remove(): void;
  };
  instance.init = def.init;
  instance.update = def.update;
  instance.remove = def.remove;
  instance._startUptimizr = def._startUptimizr;
  instance.init();
  // A-Frame always fires one `update({})` immediately after `init`.
  instance.update({});
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.use.mockReturnValue(h.client);
});

describe("uptimizr component", () => {
  it("starts capture with the scene/camera/renderer from the scene element", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    const el = makeSceneEl(true);
    mount(def, el);

    expect(h.trackScene).toHaveBeenCalledTimes(1);
    const [scene, camera, renderer] = h.trackScene.mock.calls[0]!;
    expect(scene).toBe(el.object3D);
    expect(camera).toBe(el.camera);
    expect(renderer).toBe(el.renderer);
  });

  it("attributes the session to the aframe connector with the library version", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    mount(def, makeSceneEl(true));

    const opts = h.trackScene.mock.calls[0]![3] as {
      projectId: string;
      endpoint: string;
      connector?: { name?: string; version?: string };
    };
    expect(opts.projectId).toBe("proj_demo");
    expect(opts.endpoint).toBe("http://localhost:4318");
    expect(opts.connector).toEqual({ name: "aframe", version: LIB_VERSION });
  });

  it("omits the connector version when A-Frame's version is unknown", () => {
    const def = createUptimizrComponent();
    mount(def, makeSceneEl(true));

    const opts = h.trackScene.mock.calls[0]![3] as { connector?: { name?: string } };
    expect(opts.connector).toEqual({ name: "aframe" });
  });

  it("maps the opt-in capture toggles onto the three connector", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    mount(def, makeSceneEl(true), {
      meshVisibility: true,
      hoverDwell: true,
      resourceSample: true,
      gaze: true,
    });

    const opts = h.trackScene.mock.calls[0]![3] as {
      capture?: Record<string, boolean>;
    };
    expect(opts.capture).toEqual({
      meshVisibility: true,
      hoverDwell: true,
      resourceSample: true,
      gaze: true,
    });
  });

  it("enables WebXR capture by default (forwarded to trackScene, not disabled)", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    mount(def, makeSceneEl(true));

    expect(h.trackScene).toHaveBeenCalledTimes(1);
    const opts = h.trackScene.mock.calls[0]![3] as { xr?: unknown };
    // Undefined ⇒ three's default-on XR capture applies; never disabled.
    expect(opts.xr).not.toBe(false);
  });

  it("forwards the XR sample rate when xrSampleMs is set", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    mount(def, makeSceneEl(true), { xrSampleMs: 120 });

    const opts = h.trackScene.mock.calls[0]![3] as { xr?: { sampleMs?: number } };
    expect(opts.xr).toEqual({ sampleMs: 120 });
  });

  it("disables WebXR capture when xr is false", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    mount(def, makeSceneEl(true), { xr: false });

    expect(h.trackScene).toHaveBeenCalledTimes(1);
    const opts = h.trackScene.mock.calls[0]![3] as { xr?: unknown };
    expect(opts.xr).toBe(false);
  });

  it("does not start capture when disabled", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    mount(def, makeSceneEl(true), { disabled: true });

    expect(h.trackScene).not.toHaveBeenCalled();
  });

  it("starts capture when `disabled` is toggled false at runtime (consent opt-in)", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    const instance = mount(def, makeSceneEl(true), {
      disabled: true,
    }) as UptimizrComponentInstance & { update(oldData: Partial<UptimizrComponentData>): void };

    expect(h.trackScene).not.toHaveBeenCalled();

    // A-Frame mutates `data` then calls `update(oldData)` on `setAttribute`.
    instance.data.disabled = false;
    instance.update({ disabled: true });

    expect(h.trackScene).toHaveBeenCalledTimes(1);
  });

  it("stops capture when `disabled` is toggled true at runtime (consent opt-out)", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    const instance = mount(def, makeSceneEl(true)) as UptimizrComponentInstance & {
      update(oldData: Partial<UptimizrComponentData>): void;
    };

    expect(h.trackScene).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();

    instance.data.disabled = true;
    instance.update({ disabled: false });

    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledWith("manual");
  });

  it("defers start when `disabled` is toggled false before the scene is ready", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    const el = makeSceneEl(false);
    const instance = mount(def, el, { disabled: true }) as UptimizrComponentInstance & {
      update(oldData: Partial<UptimizrComponentData>): void;
    };

    // Disabled at init: no readiness listeners attached yet.
    expect(el.listeners["loaded"]?.length ?? 0).toBe(0);

    instance.data.disabled = false;
    instance.update({ disabled: true });

    // Opted in but scene not ready: defers via readiness listeners, no start yet.
    expect(h.trackScene).not.toHaveBeenCalled();
    expect(el.listeners["loaded"]?.length).toBe(1);

    (el as { camera: unknown }).camera = { name: "camera" };
    (el as { renderer: unknown }).renderer = {
      name: "renderer",
      xr: {
        addEventListener() {},
        removeEventListener() {},
        isPresenting: false,
        getSession: () => undefined,
      },
    };
    (el as { hasLoaded: boolean }).hasLoaded = true;
    el.dispatch("loaded");

    expect(h.trackScene).toHaveBeenCalledTimes(1);
  });

  it("defers start until the scene is ready, then starts once", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    const el = makeSceneEl(false);
    mount(def, el);

    // Not ready at init: nothing started, but readiness listeners are attached.
    expect(h.trackScene).not.toHaveBeenCalled();
    expect(el.listeners["loaded"]?.length).toBe(1);
    expect(el.listeners["camera-set-active"]?.length).toBe(1);

    // The renderer/camera appear, then A-Frame fires `loaded`.
    (el as { camera: unknown }).camera = { name: "camera" };
    (el as { renderer: unknown }).renderer = {
      name: "renderer",
      xr: {
        addEventListener() {},
        removeEventListener() {},
        isPresenting: false,
        getSession: () => undefined,
      },
    };
    (el as { hasLoaded: boolean }).hasLoaded = true;
    el.dispatch("loaded");

    expect(h.trackScene).toHaveBeenCalledTimes(1);
    // Readiness listeners are removed once started, so a later event is a no-op.
    el.dispatch("camera-set-active");
    expect(h.trackScene).toHaveBeenCalledTimes(1);
  });

  it("stops capture (dispose) on remove()", () => {
    const def = createUptimizrComponent(LIB_VERSION);
    const el = makeSceneEl(true);
    const instance = mount(def, el) as UptimizrComponentInstance & { remove(): void };

    expect(h.stop).not.toHaveBeenCalled();
    instance.remove();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledWith("manual");
  });
});

describe("registerUptimizrComponent", () => {
  function makeAframe(version?: string): AframeLike & {
    registerComponent: ReturnType<typeof vi.fn>;
    components: Record<string, unknown>;
  } {
    const components: Record<string, unknown> = {};
    const registerComponent = vi.fn((name: string, def: unknown) => {
      components[name] = def;
    });
    return { registerComponent, components, ...(version ? { version } : {}) };
  }

  it("registers the component and is idempotent", () => {
    const aframe = makeAframe(LIB_VERSION);
    expect(registerUptimizrComponent(aframe)).toBe(true);
    expect(aframe.registerComponent).toHaveBeenCalledWith(COMPONENT_NAME, expect.anything());

    // Second call no-ops because the component is already present.
    expect(registerUptimizrComponent(aframe)).toBe(true);
    expect(aframe.registerComponent).toHaveBeenCalledTimes(1);
  });

  it("returns false when no A-Frame is available", () => {
    expect(registerUptimizrComponent({} as AframeLike)).toBe(false);
  });
});
