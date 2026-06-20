import { createElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, render } from "@testing-library/react";

// Stub the capture engine and the R3F store. R3F renders real WebGL which jsdom
// can't provide, so we never mount a live `<Canvas>`: `useThree` returns a fake
// store and `@uptimizr/three`'s `trackScene` is a spy returning a fake client. This
// keeps the test on the React glue this package actually owns.
const h = vi.hoisted(() => {
  const stop = vi.fn(() => Promise.resolve());
  const client = { stop, sessionId: "sess_test" };
  const trackScene = vi.fn(() => client);
  const state = {
    camera: { name: "camera", isPerspectiveCamera: true },
    scene: { name: "scene" },
    gl: { domElement: { tagName: "CANVAS" } },
  };
  return { stop, client, trackScene, state };
});

vi.mock("@uptimizr/three", () => ({ trackScene: h.trackScene }));
vi.mock("@react-three/fiber", () => ({
  useThree: (selector?: (s: typeof h.state) => unknown) => (selector ? selector(h.state) : h.state),
}));

import { useUptimizr } from "../useUptimizr.js";
import { Uptimizr } from "../Uptimizr.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useUptimizr", () => {
  it("starts capture with the scene/camera/gl from useThree", () => {
    renderHook(() => useUptimizr({ projectId: "proj_demo", endpoint: "http://localhost:4318" }));

    expect(h.trackScene).toHaveBeenCalledTimes(1);
    const [scene, camera, gl] = h.trackScene.mock.calls[0]!;
    expect(scene).toBe(h.state.scene);
    expect(camera).toBe(h.state.camera);
    expect(gl).toBe(h.state.gl);
  });

  it("attributes the session to the r3f connector by default", () => {
    renderHook(() => useUptimizr({ projectId: "proj_demo", endpoint: "http://localhost:4318" }));

    const opts = h.trackScene.mock.calls[0]![3] as { connector?: { name?: string } };
    expect(opts.connector).toEqual({ name: "r3f" });
  });

  it("lets the caller override connector fields while defaulting the name to r3f", () => {
    renderHook(() =>
      useUptimizr({
        projectId: "proj_demo",
        endpoint: "http://localhost:4318",
        connector: { version: "1.2.3" },
      }),
    );

    const opts = h.trackScene.mock.calls[0]![3] as {
      connector?: { name?: string; version?: string };
    };
    expect(opts.connector).toEqual({ name: "r3f", version: "1.2.3" });
  });

  it("forwards gaze capture options through to the three connector (ADR 0030)", () => {
    renderHook(() =>
      useUptimizr({
        projectId: "proj_demo",
        endpoint: "http://localhost:4318",
        capture: { gaze: true },
        gaze: { maxDistance: 50, meshes: ["Wall"] },
      }),
    );

    const opts = h.trackScene.mock.calls[0]![3] as {
      capture?: { gaze?: boolean };
      gaze?: { maxDistance?: number; meshes?: string[] };
    };
    expect(opts.capture).toMatchObject({ gaze: true });
    expect(opts.gaze).toEqual({ maxDistance: 50, meshes: ["Wall"] });
  });

  it("stops capture (dispose) on unmount", () => {
    const { unmount } = renderHook(() =>
      useUptimizr({ projectId: "proj_demo", endpoint: "http://localhost:4318" }),
    );

    expect(h.stop).not.toHaveBeenCalled();
    unmount();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledWith("manual");
  });

  it("does not start capture when disabled", () => {
    renderHook(() =>
      useUptimizr({ projectId: "proj_demo", endpoint: "http://localhost:4318", disabled: true }),
    );

    expect(h.trackScene).not.toHaveBeenCalled();
  });

  it("starts capture when `disabled` flips from true to false (consent opt-in)", () => {
    const { rerender } = renderHook(
      (props: { disabled: boolean }) =>
        useUptimizr({
          projectId: "proj_demo",
          endpoint: "http://localhost:4318",
          disabled: props.disabled,
        }),
      { initialProps: { disabled: true } },
    );

    expect(h.trackScene).not.toHaveBeenCalled();

    rerender({ disabled: false });
    expect(h.trackScene).toHaveBeenCalledTimes(1);
  });

  it("stops capture when `disabled` flips from false to true (consent opt-out)", () => {
    const { rerender } = renderHook(
      (props: { disabled: boolean }) =>
        useUptimizr({
          projectId: "proj_demo",
          endpoint: "http://localhost:4318",
          disabled: props.disabled,
        }),
      { initialProps: { disabled: false } },
    );

    expect(h.trackScene).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();

    rerender({ disabled: true });
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledWith("manual");
  });

  it("passes capture/sampling options straight through to the three connector", () => {
    renderHook(() =>
      useUptimizr({
        projectId: "proj_demo",
        endpoint: "http://localhost:4318",
        sampling: { camera: 10 },
        capture: { meshVisibility: true },
      }),
    );

    const opts = h.trackScene.mock.calls[0]![3] as {
      sampling?: { camera?: number };
      capture?: { meshVisibility?: boolean };
    };
    expect(opts.sampling).toEqual({ camera: 10 });
    expect(opts.capture).toEqual({ meshVisibility: true });
  });
});

describe("<Uptimizr>", () => {
  it("wires capture and renders nothing", () => {
    const { container } = render(
      createElement(Uptimizr, { projectId: "proj_demo", endpoint: "http://localhost:4318" }),
    );

    expect(h.trackScene).toHaveBeenCalledTimes(1);
    expect(container.firstChild).toBeNull();
  });

  it("stops capture on unmount", () => {
    const { unmount } = render(
      createElement(Uptimizr, { projectId: "proj_demo", endpoint: "http://localhost:4318" }),
    );

    unmount();
    expect(h.stop).toHaveBeenCalledWith("manual");
  });
});
