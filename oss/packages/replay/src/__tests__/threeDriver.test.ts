import { describe, expect, it, vi } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { createThreeReplayDriver } from "../drivers/three.js";

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
  const positionSet = vi.fn();
  const lookAt = vi.fn();
  const updateProjectionMatrix = vi.fn();
  const camera = {
    position: { set: positionSet },
    lookAt,
    isPerspectiveCamera: true,
    fov: 50,
    updateProjectionMatrix,
  };
  return { camera, positionSet, lookAt, updateProjectionMatrix };
}

describe("createThreeReplayDriver — camera", () => {
  it("converts canonical position to three's frame (Z-negated) and looks at the target", () => {
    const { camera, positionSet, lookAt } = makeCamera();
    const driver = createThreeReplayDriver({ scene: {}, camera });

    // Canonical position [5,6,7] → three [5,6,-7]; explicit canonical target [1,2,3] → [1,2,-3].
    driver.apply(cameraEvent({ target: [1, 2, 3] }));

    expect(positionSet).toHaveBeenCalledWith(5, 6, -7);
    expect(lookAt).toHaveBeenCalledWith(1, 2, -3);
  });

  it("derives the look target from position + direction when no target is given", () => {
    const { camera, positionSet, lookAt } = makeCamera();
    const driver = createThreeReplayDriver({ scene: {}, camera });

    // Canonical forward +Z → three -Z; target = three-position + three-direction.
    driver.apply(cameraEvent({ position: [0, 0, 0], direction: [0, 0, 1] }));

    expect(positionSet).toHaveBeenCalledWith(0, 0, 0);
    // three position [0,0,0] + three direction [0,0,-1] = [0,0,-1].
    expect(lookAt).toHaveBeenCalledWith(0, 0, -1);
  });

  it("applies fov in degrees and updates the projection matrix", () => {
    const { camera, lookAt, updateProjectionMatrix } = makeCamera();
    const driver = createThreeReplayDriver({ scene: {}, camera });

    driver.apply(cameraEvent({ fov: Math.PI / 2 }));

    expect(camera.fov).toBeCloseTo(90, 5);
    expect(updateProjectionMatrix).toHaveBeenCalledTimes(1);
    expect(lookAt).toHaveBeenCalledTimes(1);
  });
});

describe("createThreeReplayDriver — forwarded events", () => {
  it("forwards pointer events with the hit point converted to three's frame", () => {
    const { camera } = makeCamera();
    const onPointer = vi.fn();
    const driver = createThreeReplayDriver({ scene: {}, camera, onPointer });

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

    // hitPoint canonical [1,2,3] → three [1,2,-3]; screen passed through.
    expect(onPointer).toHaveBeenCalledWith([0.5, 0.5], [1, 2, -3], "box-1", "pointer_click");
  });

  it("forwards mesh interactions with the point converted to three's frame", () => {
    const { camera } = makeCamera();
    const onMeshInteraction = vi.fn();
    const driver = createThreeReplayDriver({ scene: {}, camera, onMeshInteraction });

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
    const driver = createThreeReplayDriver({ scene: {}, camera, onCustom, onLifecycle, onError });

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
    const driver = createThreeReplayDriver({ scene: {}, camera, onInputAction });

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
    const driver = createThreeReplayDriver({ scene: {}, camera });
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
  const positionSet = vi.fn();
  const quaternionSet = vi.fn();
  const scaleSet = vi.fn();
  const node = {
    position: { set: positionSet },
    quaternion: { set: quaternionSet },
    scale: { set: scaleSet },
  };
  return { node, positionSet, quaternionSet, scaleSet };
}

/** A SkinnedMesh-like node whose `skeleton.bones` carry spy setters by name. */
function makeSkinnedNode(names: string[]) {
  const bones: Record<
    string,
    {
      positionSet: ReturnType<typeof vi.fn>;
      quaternionSet: ReturnType<typeof vi.fn>;
      scaleSet: ReturnType<typeof vi.fn>;
    }
  > = {};
  const boneList = names.map((name) => {
    const positionSet = vi.fn();
    const quaternionSet = vi.fn();
    const scaleSet = vi.fn();
    bones[name] = { positionSet, quaternionSet, scaleSet };
    return {
      name,
      position: { set: positionSet },
      quaternion: { set: quaternionSet },
      scale: { set: scaleSet },
    };
  });
  const node = {
    position: { set: vi.fn() },
    quaternion: { set: vi.fn() },
    scale: { set: vi.fn() },
    skeleton: { bones: boneList },
  };
  return { node, bones };
}

describe("createThreeReplayDriver — node_transform (ADR 0027)", () => {
  it("Tier 1: drives the node, converting position (Z-negated) and quaternion (reflected) to three", () => {
    const { node, positionSet, quaternionSet, scaleSet } = makeNode();
    const onNodeTransform = vi.fn();
    const driver = createThreeReplayDriver({
      scene: {},
      camera: makeCamera().camera,
      nodes: { hero: node },
      onNodeTransform,
    });

    driver.apply(nodeEvent());

    // Canonical [1,2,3] → three [1,2,-3].
    expect(positionSet).toHaveBeenCalledWith(1, 2, -3);
    // Quaternion canonical→three reflection negates x and y (Z-flip is its own inverse).
    expect(quaternionSet).toHaveBeenCalledWith(-0.1, -0.2, 0.3, 0.9);
    expect(scaleSet).toHaveBeenCalledWith(2, 2, 2);
    // The host callback receives the same (converted) frame.
    expect(onNodeTransform.mock.calls[0]![0]).toBe("hero");
    expect(onNodeTransform.mock.calls[0]![1].position).toEqual([1, 2, -3]);
    expect(onNodeTransform.mock.calls[0]![1].rotation).toEqual([-0.1, -0.2, 0.3, 0.9]);
    expect(onNodeTransform.mock.calls[0]![2]).toBe(10);
  });

  it("resolves a node via a () => node accessor and omits scale when absent", () => {
    const { node, positionSet, scaleSet } = makeNode();
    const driver = createThreeReplayDriver({
      scene: {},
      camera: makeCamera().camera,
      nodes: { hero: () => node },
    });

    driver.apply(nodeEvent({ scale: undefined }));

    expect(positionSet).toHaveBeenCalledWith(1, 2, -3);
    expect(scaleSet).not.toHaveBeenCalled();
  });

  it("does not drive the node for a Tier-2 bone sample but still forwards it", () => {
    const { node, positionSet } = makeNode();
    const onNodeTransform = vi.fn();
    const driver = createThreeReplayDriver({
      scene: {},
      camera: makeCamera().camera,
      nodes: { hero: node },
      onNodeTransform,
    });

    driver.apply(nodeEvent({ boneId: "Spine" }));

    // A bone sample never moves the SkinnedMesh root itself...
    expect(positionSet).not.toHaveBeenCalled();
    // ...but the sample (with boneId) is forwarded to the host.
    expect(onNodeTransform).toHaveBeenCalledTimes(1);
    expect(onNodeTransform.mock.calls[0]![1].boneId).toBe("Spine");
  });

  it("Tier 1 subtree: drives the descendant resolved by childPath (ADR 0033)", () => {
    const { node: hand, positionSet: handPos } = makeNode();
    (hand as Record<string, unknown>).name = "Hand";
    (hand as Record<string, unknown>).children = [];
    const { node: body, positionSet: bodyPos } = makeNode();
    (body as Record<string, unknown>).name = "Body";
    (body as Record<string, unknown>).children = [hand];
    const { node: rig, positionSet: rigPos } = makeNode();
    (rig as Record<string, unknown>).name = "rig";
    (rig as Record<string, unknown>).children = [body];
    const onNodeTransform = vi.fn();
    const driver = createThreeReplayDriver({
      scene: {},
      camera: makeCamera().camera,
      nodes: { rig },
      onNodeTransform,
    });

    driver.apply(nodeEvent({ nodeId: "rig", childPath: "Body/Hand" }));

    // Only the resolved descendant (Hand) is driven, not the root or intermediate.
    expect(handPos).toHaveBeenCalledWith(1, 2, -3);
    expect(bodyPos).not.toHaveBeenCalled();
    expect(rigPos).not.toHaveBeenCalled();
    // The sample (with childPath) is forwarded to the host.
    expect(onNodeTransform.mock.calls[0]![1].childPath).toBe("Body/Hand");
  });

  it("Tier 1 subtree: a missing childPath segment drives nothing but still forwards (ADR 0033)", () => {
    const { node: rig, positionSet: rigPos } = makeNode();
    (rig as Record<string, unknown>).name = "rig";
    (rig as Record<string, unknown>).children = [];
    const onNodeTransform = vi.fn();
    const driver = createThreeReplayDriver({
      scene: {},
      camera: makeCamera().camera,
      nodes: { rig },
      onNodeTransform,
    });

    driver.apply(nodeEvent({ nodeId: "rig", childPath: "Ghost" }));

    expect(rigPos).not.toHaveBeenCalled();
    expect(onNodeTransform.mock.calls[0]![1].childPath).toBe("Ghost");
  });

  it("Tier 2: drives the matching skeleton bone's local pose (converted to three)", () => {
    const { node, bones } = makeSkinnedNode(["Hips", "Spine"]);
    const onNodeTransform = vi.fn();
    const driver = createThreeReplayDriver({
      scene: {},
      camera: makeCamera().camera,
      nodes: { hero: node },
      onNodeTransform,
    });

    driver.apply(nodeEvent({ boneId: "Spine" }));

    // Only the named bone is driven, with the canonical→three conversion.
    expect(bones.Spine!.positionSet).toHaveBeenCalledWith(1, 2, -3);
    expect(bones.Spine!.quaternionSet).toHaveBeenCalledWith(-0.1, -0.2, 0.3, 0.9);
    expect(bones.Spine!.scaleSet).toHaveBeenCalledWith(2, 2, 2);
    expect(bones.Hips!.positionSet).not.toHaveBeenCalled();
    // The (converted) bone sample is also forwarded.
    expect(onNodeTransform.mock.calls[0]![1].boneId).toBe("Spine");
  });

  it("Tier 2: ignores a bone sample whose boneId is not in the skeleton", () => {
    const { node, bones } = makeSkinnedNode(["Hips"]);
    const driver = createThreeReplayDriver({
      scene: {},
      camera: makeCamera().camera,
      nodes: { hero: node },
    });

    expect(() => driver.apply(nodeEvent({ boneId: "NoSuchBone" }))).not.toThrow();
    expect(bones.Hips!.positionSet).not.toHaveBeenCalled();
  });

  it("ignores an unknown nodeId but still forwards the sample", () => {
    const onNodeTransform = vi.fn();
    const driver = createThreeReplayDriver({
      scene: {},
      camera: makeCamera().camera,
      nodes: {},
      onNodeTransform,
    });

    expect(() => driver.apply(nodeEvent({ nodeId: "missing" }))).not.toThrow();
    expect(onNodeTransform).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no nodes map or callback is provided", () => {
    const driver = createThreeReplayDriver({ scene: {}, camera: makeCamera().camera });
    expect(() => driver.apply(nodeEvent())).not.toThrow();
  });
});
