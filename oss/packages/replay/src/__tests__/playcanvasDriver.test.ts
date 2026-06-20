import { describe, expect, it, vi } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { createPlayCanvasReplayDriver } from "../drivers/playcanvas.js";

function cameraEvent(overrides: Partial<AnyEvent> = {}): AnyEvent {
  return {
    type: "camera_sample",
    projectId: "p",
    sessionId: "s",
    ts: 1,
    sdkVersion: "0.1.0",
    position: [5, 6, 7],
    direction: [0, 0, 1],
    ...overrides,
  } as AnyEvent;
}

function makeCamera() {
  const setPosition = vi.fn();
  const lookAt = vi.fn();
  const camera = {
    setPosition,
    lookAt,
    camera: { fov: 50 },
  };
  return { camera, setPosition, lookAt };
}

describe("createPlayCanvasReplayDriver — camera", () => {
  it("converts canonical position to PlayCanvas' frame (Z-negated) and looks at the target", () => {
    const { camera, setPosition, lookAt } = makeCamera();
    const driver = createPlayCanvasReplayDriver({ camera });

    // Canonical position [5,6,7] → PlayCanvas [5,6,-7]; canonical target [1,2,3] → [1,2,-3].
    driver.apply(cameraEvent({ target: [1, 2, 3] }));

    expect(setPosition).toHaveBeenCalledWith(5, 6, -7);
    expect(lookAt).toHaveBeenCalledWith(1, 2, -3);
  });

  it("derives the look target from position + direction when no target is given", () => {
    const { camera, setPosition, lookAt } = makeCamera();
    const driver = createPlayCanvasReplayDriver({ camera });

    // Canonical forward +Z → PlayCanvas -Z; target = position + direction.
    driver.apply(cameraEvent({ position: [0, 0, 0], direction: [0, 0, 1] }));

    expect(setPosition).toHaveBeenCalledWith(0, 0, 0);
    expect(lookAt).toHaveBeenCalledWith(0, 0, -1);
  });

  it("applies fov in degrees on the camera component", () => {
    const { camera, lookAt } = makeCamera();
    const driver = createPlayCanvasReplayDriver({ camera });

    driver.apply(cameraEvent({ fov: Math.PI / 2 }));

    expect(camera.camera.fov).toBeCloseTo(90, 5);
    expect(lookAt).toHaveBeenCalledTimes(1);
  });
});

describe("createPlayCanvasReplayDriver — forwarded events", () => {
  it("forwards pointer events with the hit point converted to PlayCanvas' frame", () => {
    const { camera } = makeCamera();
    const onPointer = vi.fn();
    const driver = createPlayCanvasReplayDriver({ camera, onPointer });

    driver.apply({
      type: "pointer_click",
      projectId: "p",
      sessionId: "s",
      ts: 2,
      sdkVersion: "0.1.0",
      screen: [0.5, 0.5],
      hitPoint: [1, 2, 3],
      hitMesh: "box-1",
    } as AnyEvent);

    expect(onPointer).toHaveBeenCalledWith([0.5, 0.5], [1, 2, -3], "box-1", "pointer_click");
  });

  it("forwards mesh interactions with the point converted to PlayCanvas' frame", () => {
    const { camera } = makeCamera();
    const onMeshInteraction = vi.fn();
    const driver = createPlayCanvasReplayDriver({ camera, onMeshInteraction });

    driver.apply({
      type: "mesh_interaction",
      projectId: "p",
      sessionId: "s",
      ts: 3,
      sdkVersion: "0.1.0",
      mesh: "box-2",
      kind: "pick",
      point: [4, 5, 6],
    } as AnyEvent);

    expect(onMeshInteraction).toHaveBeenCalledWith("box-2", "pick", [4, 5, -6]);
  });

  it("forwards custom, lifecycle, and error events", () => {
    const { camera } = makeCamera();
    const onCustom = vi.fn();
    const onLifecycle = vi.fn();
    const onError = vi.fn();
    const driver = createPlayCanvasReplayDriver({ camera, onCustom, onLifecycle, onError });

    driver.apply({
      type: "custom",
      projectId: "p",
      sessionId: "s",
      ts: 4,
      sdkVersion: "0.1.0",
      name: "box_picked",
      props: { box: "box-1" },
    } as AnyEvent);
    expect(onCustom).toHaveBeenCalledWith("box_picked", { box: "box-1" }, 4);

    driver.apply({
      type: "context_lost",
      projectId: "p",
      sessionId: "s",
      ts: 5,
      sdkVersion: "0.1.0",
    } as AnyEvent);
    expect(onLifecycle).toHaveBeenCalledWith({ type: "context_lost" }, 5);

    driver.apply({
      type: "runtime_error",
      projectId: "p",
      sessionId: "s",
      ts: 6,
      sdkVersion: "0.1.0",
      kind: "error",
      message: "boom",
    } as AnyEvent);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error", message: "boom" }),
      6,
    );
  });

  it("forwards an input_action with its action, raw code, source, and timestamp", () => {
    const { camera } = makeCamera();
    const onInputAction = vi.fn();
    const driver = createPlayCanvasReplayDriver({ camera, onInputAction });

    driver.apply({
      type: "input_action",
      projectId: "p",
      sessionId: "s",
      ts: 8,
      sdkVersion: "0.1.0",
      action: "next-camera",
      source: "keyboard",
      code: "KeyN",
      pressed: true,
    } as AnyEvent);

    expect(onInputAction).toHaveBeenCalledWith(
      { action: "next-camera", code: "KeyN", button: undefined, pressed: true, source: "keyboard" },
      8,
    );
  });

  it("never throws on an unknown event type", () => {
    const { camera } = makeCamera();
    const driver = createPlayCanvasReplayDriver({ camera });
    expect(() =>
      driver.apply({
        type: "frame_perf",
        projectId: "p",
        sessionId: "s",
        ts: 7,
        sdkVersion: "0.1.0",
        fps: 60,
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
    rotation: [0.1, 0.2, 0.3, 0.9],
    scale: [2, 2, 2],
    ...overrides,
  } as AnyEvent;
}

function makeNode() {
  const setPosition = vi.fn();
  const setRotation = vi.fn();
  const setLocalScale = vi.fn();
  const node = { setPosition, setRotation, setLocalScale };
  return { node, setPosition, setRotation, setLocalScale };
}

/** A skinned Entity whose render mesh instances share one bone set with spy setters. */
function makeSkinnedNode(names: string[]) {
  const bones: Record<
    string,
    {
      setLocalPosition: ReturnType<typeof vi.fn>;
      setLocalRotation: ReturnType<typeof vi.fn>;
      setLocalScale: ReturnType<typeof vi.fn>;
    }
  > = {};
  const boneList = names.map((name) => {
    const setLocalPosition = vi.fn();
    const setLocalRotation = vi.fn();
    const setLocalScale = vi.fn();
    bones[name] = { setLocalPosition, setLocalRotation, setLocalScale };
    return { name, setLocalPosition, setLocalRotation, setLocalScale };
  });
  const node = {
    setPosition: vi.fn(),
    setRotation: vi.fn(),
    setLocalScale: vi.fn(),
    render: { meshInstances: [{ skinInstance: { bones: boneList } }] },
  };
  return { node, bones };
}

describe("createPlayCanvasReplayDriver — node_transform (ADR 0027)", () => {
  it("Tier 1: drives the entity, converting position (Z-negated) and quaternion (reflected)", () => {
    const { node, setPosition, setRotation, setLocalScale } = makeNode();
    const onNodeTransform = vi.fn();
    const driver = createPlayCanvasReplayDriver({
      camera: makeCamera().camera,
      nodes: { hero: node },
      onNodeTransform,
    });

    driver.apply(nodeEvent());

    // Canonical [1,2,3] → PlayCanvas [1,2,-3].
    expect(setPosition).toHaveBeenCalledWith(1, 2, -3);
    // Quaternion canonical→PlayCanvas reflection negates x and y.
    expect(setRotation).toHaveBeenCalledWith(-0.1, -0.2, 0.3, 0.9);
    expect(setLocalScale).toHaveBeenCalledWith(2, 2, 2);
    expect(onNodeTransform.mock.calls[0]![1].position).toEqual([1, 2, -3]);
    expect(onNodeTransform.mock.calls[0]![1].rotation).toEqual([-0.1, -0.2, 0.3, 0.9]);
    expect(onNodeTransform.mock.calls[0]![2]).toBe(10);
  });

  it("resolves an entity via a () => entity accessor and omits scale when absent", () => {
    const { node, setPosition, setLocalScale } = makeNode();
    const driver = createPlayCanvasReplayDriver({
      camera: makeCamera().camera,
      nodes: { hero: () => node },
    });

    driver.apply(nodeEvent({ scale: undefined }));

    expect(setPosition).toHaveBeenCalledWith(1, 2, -3);
    expect(setLocalScale).not.toHaveBeenCalled();
  });

  it("Tier 2: drives the matching skeleton bone's local pose (converted to PlayCanvas)", () => {
    const { node, bones } = makeSkinnedNode(["Hips", "Spine"]);
    const onNodeTransform = vi.fn();
    const driver = createPlayCanvasReplayDriver({
      camera: makeCamera().camera,
      nodes: { hero: node },
      onNodeTransform,
    });

    driver.apply(nodeEvent({ boneId: "Spine" }));

    // Only the named bone is driven, with the canonical→PlayCanvas conversion.
    expect(bones.Spine!.setLocalPosition).toHaveBeenCalledWith(1, 2, -3);
    expect(bones.Spine!.setLocalRotation).toHaveBeenCalledWith(-0.1, -0.2, 0.3, 0.9);
    expect(bones.Spine!.setLocalScale).toHaveBeenCalledWith(2, 2, 2);
    expect(bones.Hips!.setLocalPosition).not.toHaveBeenCalled();
    // The root entity is never moved by a bone sample.
    expect(node.setPosition).not.toHaveBeenCalled();
    expect(onNodeTransform.mock.calls[0]![1].boneId).toBe("Spine");
  });

  it("Tier 2: ignores a bone sample whose boneId is not in the skeleton", () => {
    const { node, bones } = makeSkinnedNode(["Hips"]);
    const driver = createPlayCanvasReplayDriver({
      camera: makeCamera().camera,
      nodes: { hero: node },
    });

    expect(() => driver.apply(nodeEvent({ boneId: "NoSuchBone" }))).not.toThrow();
    expect(bones.Hips!.setLocalPosition).not.toHaveBeenCalled();
  });

  it("ignores an unknown nodeId but still forwards the sample", () => {
    const onNodeTransform = vi.fn();
    const driver = createPlayCanvasReplayDriver({
      camera: makeCamera().camera,
      nodes: {},
      onNodeTransform,
    });

    expect(() => driver.apply(nodeEvent({ nodeId: "missing" }))).not.toThrow();
    expect(onNodeTransform).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no nodes map or callback is provided", () => {
    const driver = createPlayCanvasReplayDriver({ camera: makeCamera().camera });
    expect(() => driver.apply(nodeEvent())).not.toThrow();
  });
});
