import { describe, expect, it, vi } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { createBabylonReplayDriver } from "../drivers/babylon.js";

function cameraEvent(overrides: Partial<AnyEvent> = {}): AnyEvent {
  return {
    type: "camera_sample",
    projectId: "p",
    sessionId: "s",
    ts: 1,
    sdkVersion: "0.1.0",
    position: [5, 6, 7],
    direction: [0, 0, 1],
    target: [1, 2, 3],
    ...overrides,
  } as AnyEvent;
}

describe("createBabylonReplayDriver — camera", () => {
  it("uses setPosition when available (ArcRotateCamera-style)", () => {
    const setPosition = vi.fn();
    const setTarget = vi.fn();
    const positionSet = vi.fn();
    const camera = {
      position: { set: positionSet },
      setTarget,
      setPosition,
    };
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: camera } as never,
    });

    driver.apply(cameraEvent());

    // ArcRotate must use setPosition (a direct position.set would be overwritten
    // each frame), and the target must be applied first.
    expect(setPosition).toHaveBeenCalledTimes(1);
    expect(positionSet).not.toHaveBeenCalled();
    const posArg = setPosition.mock.calls[0]![0] as { x: number; y: number; z: number };
    expect([posArg.x, posArg.y, posArg.z]).toEqual([5, 6, 7]);
    const targetArg = setTarget.mock.calls[0]![0] as { x: number; y: number; z: number };
    expect([targetArg.x, targetArg.y, targetArg.z]).toEqual([1, 2, 3]);
  });

  it("falls back to direct position.set for free/target cameras", () => {
    const positionSet = vi.fn();
    const setTarget = vi.fn();
    const camera = { position: { set: positionSet }, setTarget };
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: camera } as never,
    });

    driver.apply(cameraEvent({ target: undefined }));

    expect(positionSet).toHaveBeenCalledWith(5, 6, 7);
    // No explicit target → derived from position + direction.
    const targetArg = setTarget.mock.calls[0]![0] as { x: number; y: number; z: number };
    expect([targetArg.x, targetArg.y, targetArg.z]).toEqual([5, 6, 8]);
  });
});

describe("createBabylonReplayDriver — pointer", () => {
  it("forwards the pointer event type so hosts can color-code clicks", () => {
    const onPointer = vi.fn();
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
      onPointer,
    });

    driver.apply({
      type: "pointer_move",
      projectId: "p",
      sessionId: "s",
      ts: 1,
      sdkVersion: "0.1.0",
      screen: [0.5, 0.5],
    } as AnyEvent);
    driver.apply({
      type: "pointer_click",
      projectId: "p",
      sessionId: "s",
      ts: 2,
      sdkVersion: "0.1.0",
      screen: [0.25, 0.75],
      button: 0,
    } as AnyEvent);

    expect(onPointer.mock.calls[0]![3]).toBe("pointer_move");
    expect(onPointer.mock.calls[1]![3]).toBe("pointer_click");
    expect(onPointer.mock.calls[1]![0]).toEqual([0.25, 0.75]);
  });
});

describe("createBabylonReplayDriver — custom", () => {
  it("forwards custom event name, props, and timestamp to the host", () => {
    const onCustom = vi.fn();
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
      onCustom,
    });

    driver.apply({
      type: "custom",
      projectId: "p",
      sessionId: "s",
      ts: 42,
      sdkVersion: "0.1.0",
      name: "add_to_cart",
      props: { sku: "ABC-123", qty: 2 },
    } as AnyEvent);

    expect(onCustom).toHaveBeenCalledTimes(1);
    expect(onCustom.mock.calls[0]![0]).toBe("add_to_cart");
    expect(onCustom.mock.calls[0]![1]).toEqual({ sku: "ABC-123", qty: 2 });
    expect(onCustom.mock.calls[0]![2]).toBe(42);
  });

  it("does not throw when no onCustom handler is provided", () => {
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
    });

    expect(() =>
      driver.apply({
        type: "custom",
        projectId: "p",
        sessionId: "s",
        ts: 1,
        sdkVersion: "0.1.0",
        name: "ping",
      } as AnyEvent),
    ).not.toThrow();
  });
});

describe("createBabylonReplayDriver — input_action", () => {
  it("forwards the action, raw code/button, source, and timestamp to the host", () => {
    const onInputAction = vi.fn();
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
      onInputAction,
    });

    driver.apply({
      type: "input_action",
      projectId: "p",
      sessionId: "s",
      ts: 55,
      sdkVersion: "0.1.0",
      action: "next-camera",
      source: "keyboard",
      code: "KeyN",
      pressed: true,
    } as AnyEvent);

    expect(onInputAction).toHaveBeenCalledTimes(1);
    expect(onInputAction.mock.calls[0]![0]).toEqual({
      action: "next-camera",
      code: "KeyN",
      button: undefined,
      pressed: true,
      source: "keyboard",
    });
    expect(onInputAction.mock.calls[0]![1]).toBe(55);
  });

  it("does not throw when no onInputAction handler is provided", () => {
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
    });

    expect(() =>
      driver.apply({
        type: "input_action",
        projectId: "p",
        sessionId: "s",
        ts: 1,
        sdkVersion: "0.1.0",
        action: "jump",
        source: "gamepad",
        button: 0,
      } as AnyEvent),
    ).not.toThrow();
  });
});

describe("createBabylonReplayDriver — lifecycle", () => {
  function lifecycleEvent(extra: Record<string, unknown>): AnyEvent {
    return {
      projectId: "p",
      sessionId: "s",
      ts: 7,
      sdkVersion: "0.1.0",
      ...extra,
    } as AnyEvent;
  }

  it("forwards each lifecycle event type with its timestamp", () => {
    const onLifecycle = vi.fn();
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
      onLifecycle,
    });

    driver.apply(lifecycleEvent({ type: "viewport_resize", width: 1280, height: 720, dpr: 2 }));
    driver.apply(lifecycleEvent({ type: "visibility_change", state: "hidden" }));
    driver.apply(lifecycleEvent({ type: "focus_change", focused: false }));
    driver.apply(lifecycleEvent({ type: "context_lost" }));
    driver.apply(lifecycleEvent({ type: "context_restored" }));

    expect(onLifecycle).toHaveBeenCalledTimes(5);
    expect(onLifecycle.mock.calls[0]![0]).toEqual({
      type: "viewport_resize",
      width: 1280,
      height: 720,
      dpr: 2,
    });
    expect(onLifecycle.mock.calls[1]![0]).toEqual({ type: "visibility_change", state: "hidden" });
    expect(onLifecycle.mock.calls[2]![0]).toEqual({ type: "focus_change", focused: false });
    expect(onLifecycle.mock.calls[3]![0]).toEqual({ type: "context_lost" });
    expect(onLifecycle.mock.calls[4]![0]).toEqual({ type: "context_restored" });
    expect(onLifecycle.mock.calls[0]![1]).toBe(7);
  });

  it("does not throw when no onLifecycle handler is provided", () => {
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
    });

    expect(() => driver.apply(lifecycleEvent({ type: "context_lost" }))).not.toThrow();
  });
});

describe("createBabylonReplayDriver — runtime_error", () => {
  it("forwards a runtime_error with all fields and timestamp", () => {
    const onError = vi.fn();
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
      onError,
    });

    driver.apply({
      type: "runtime_error",
      projectId: "p",
      sessionId: "s",
      ts: 99,
      sdkVersion: "0.1.0",
      kind: "error",
      message: "boom",
      source: "https://app.example/main.js",
      lineno: 42,
      colno: 7,
      stack: "Error: boom",
    } as AnyEvent);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toEqual({
      kind: "error",
      message: "boom",
      source: "https://app.example/main.js",
      lineno: 42,
      colno: 7,
      stack: "Error: boom",
    });
    expect(onError.mock.calls[0]![1]).toBe(99);
  });

  it("does not throw when no onError handler is provided", () => {
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
    });

    expect(() =>
      driver.apply({
        type: "runtime_error",
        projectId: "p",
        sessionId: "s",
        ts: 1,
        sdkVersion: "0.1.0",
        kind: "unhandledrejection",
        message: "nope",
      } as AnyEvent),
    ).not.toThrow();
  });
});

function nodeEvent(overrides: Partial<AnyEvent> = {}): AnyEvent {
  return {
    type: "node_transform",
    projectId: "p",
    sessionId: "s",
    ts: 10,
    sdkVersion: "0.1.0",
    nodeId: "hero",
    position: [1, 2, 3],
    rotation: [0, 0, 0, 1],
    scale: [2, 2, 2],
    ...overrides,
  } as AnyEvent;
}

describe("createBabylonReplayDriver — node_transform (ADR 0027)", () => {
  it("Tier 1: drives the node world transform via setAbsolutePosition + fresh quaternion", () => {
    const setAbsolutePosition = vi.fn();
    const scalingSet = vi.fn();
    const node = {
      setAbsolutePosition,
      scaling: { set: scalingSet },
      rotationQuaternion: null as unknown,
    };
    const onNodeTransform = vi.fn();
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
      nodes: { hero: node },
      onNodeTransform,
    });

    driver.apply(nodeEvent({ rotation: [0.1, 0.2, 0.3, 0.9] }));

    const posArg = setAbsolutePosition.mock.calls[0]![0] as { x: number; y: number; z: number };
    expect([posArg.x, posArg.y, posArg.z]).toEqual([1, 2, 3]);
    // A fresh Quaternion is assigned so Babylon applies the world orientation verbatim.
    const q = node.rotationQuaternion as { x: number; y: number; z: number; w: number };
    expect([q.x, q.y, q.z, q.w]).toEqual([0.1, 0.2, 0.3, 0.9]);
    expect(scalingSet).toHaveBeenCalledWith(2, 2, 2);
    // The (canonical) sample is always forwarded to the host callback.
    expect(onNodeTransform).toHaveBeenCalledTimes(1);
    expect(onNodeTransform.mock.calls[0]![0]).toBe("hero");
    expect(onNodeTransform.mock.calls[0]![1].boneId).toBeUndefined();
    expect(onNodeTransform.mock.calls[0]![2]).toBe(10);
  });

  it("Tier 1: falls back to position.set when setAbsolutePosition is absent", () => {
    const positionSet = vi.fn();
    const node = { position: { set: positionSet }, rotationQuaternion: null as unknown };
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
      nodes: { hero: node },
    });

    driver.apply(nodeEvent({ scale: undefined }));

    expect(positionSet).toHaveBeenCalledWith(1, 2, 3);
  });

  it("resolves a node via a () => node accessor", () => {
    const positionSet = vi.fn();
    const node = { position: { set: positionSet }, rotationQuaternion: null as unknown };
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
      nodes: { hero: () => node },
    });

    driver.apply(nodeEvent());

    expect(positionSet).toHaveBeenCalledWith(1, 2, 3);
  });

  it("Tier 2: drives the matching skeleton bone's local pose and marks it dirty", () => {
    const bonePosSet = vi.fn();
    const boneScaleSet = vi.fn();
    const markAsDirty = vi.fn();
    const bone = {
      name: "Spine",
      position: { set: bonePosSet },
      scaling: { set: boneScaleSet },
      rotationQuaternion: null as unknown,
      markAsDirty,
    };
    const node = { skeleton: { bones: [{ name: "Hips" }, bone] } };
    const onNodeTransform = vi.fn();
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
      nodes: { hero: node },
      onNodeTransform,
    });

    driver.apply(nodeEvent({ boneId: "Spine", rotation: [0, 1, 0, 0] }));

    expect(bonePosSet).toHaveBeenCalledWith(1, 2, 3);
    const bq = bone.rotationQuaternion as { x: number; y: number; z: number; w: number };
    expect([bq.x, bq.y, bq.z, bq.w]).toEqual([0, 1, 0, 0]);
    expect(boneScaleSet).toHaveBeenCalledWith(2, 2, 2);
    expect(markAsDirty).toHaveBeenCalledTimes(1);
    expect(onNodeTransform.mock.calls[0]![1].boneId).toBe("Spine");
  });

  it("ignores an unknown nodeId but still forwards the sample", () => {
    const onNodeTransform = vi.fn();
    const driver = createBabylonReplayDriver({
      scene: { activeCamera: null } as never,
      nodes: {},
      onNodeTransform,
    });

    expect(() => driver.apply(nodeEvent({ nodeId: "missing" }))).not.toThrow();
    expect(onNodeTransform).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no nodes map or callback is provided", () => {
    const driver = createBabylonReplayDriver({ scene: { activeCamera: null } as never });
    expect(() => driver.apply(nodeEvent())).not.toThrow();
  });
});
