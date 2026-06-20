import { describe, expect, it, vi } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { createBabylonLiteReplayDriver } from "../drivers/babylon-lite.js";

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

function makeArcCamera() {
  return { alpha: 0, beta: 0, radius: 0, target: { x: 0, y: 0, z: 0 }, fov: 0.8 };
}

describe("createBabylonLiteReplayDriver — camera", () => {
  it("inverts Babylon's spherical orbit mapping for an ArcRotate camera (left-handed identity)", () => {
    const camera = makeArcCamera();
    const driver = createBabylonLiteReplayDriver({ camera });

    // Lite is left-handed → canonical is identity. target [1,2,3], pos [5,6,7] → orbit [4,4,4].
    driver.apply(cameraEvent({ target: [1, 2, 3] }));

    expect(camera.target).toEqual({ x: 1, y: 2, z: 3 });
    expect(camera.radius).toBeCloseTo(Math.hypot(4, 4, 4), 5);
    expect(camera.beta).toBeCloseTo(Math.acos(4 / Math.hypot(4, 4, 4)), 5);
    expect(camera.alpha).toBeCloseTo(Math.atan2(4, 4), 5);
  });

  it("derives the target from position + direction when no target is given", () => {
    const camera = makeArcCamera();
    const driver = createBabylonLiteReplayDriver({ camera });

    // pos [0,0,0], forward +Z → target [0,0,1].
    driver.apply(cameraEvent({ position: [0, 0, 0], direction: [0, 0, 1] }));

    expect(camera.target).toEqual({ x: 0, y: 0, z: 1 });
    expect(camera.radius).toBeCloseTo(1, 5);
  });

  it("applies fov in radians without conversion", () => {
    const camera = makeArcCamera();
    const driver = createBabylonLiteReplayDriver({ camera });

    driver.apply(cameraEvent({ fov: Math.PI / 2 }));

    expect(camera.fov).toBeCloseTo(Math.PI / 2, 5);
  });

  it("skips pose re-drive for non-ArcRotate cameras", () => {
    const camera = { fov: 1 };
    const driver = createBabylonLiteReplayDriver({ camera });
    // Should not throw nor mutate anything it can't.
    expect(() => driver.apply(cameraEvent({ target: [1, 2, 3] }))).not.toThrow();
  });
});

describe("createBabylonLiteReplayDriver — forwarded events", () => {
  it("forwards pointer events (hit point is left-handed identity)", () => {
    const onPointer = vi.fn();
    const driver = createBabylonLiteReplayDriver({ camera: makeArcCamera(), onPointer });

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

    expect(onPointer).toHaveBeenCalledWith([0.5, 0.5], [1, 2, 3], "box-1", "pointer_click");
  });

  it("forwards mesh interactions", () => {
    const onMeshInteraction = vi.fn();
    const driver = createBabylonLiteReplayDriver({ camera: makeArcCamera(), onMeshInteraction });

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

    expect(onMeshInteraction).toHaveBeenCalledWith("box-2", "pick", [4, 5, 6]);
  });

  it("forwards custom and lifecycle events", () => {
    const onCustom = vi.fn();
    const onLifecycle = vi.fn();
    const driver = createBabylonLiteReplayDriver({
      camera: makeArcCamera(),
      onCustom,
      onLifecycle,
    });

    driver.apply({
      type: "custom",
      projectId: "p",
      sessionId: "s",
      ts: 4,
      sdkVersion: "0.1.0",
      name: "level_up",
      props: { level: 3 },
    } as AnyEvent);
    driver.apply({
      type: "visibility_change",
      projectId: "p",
      sessionId: "s",
      ts: 5,
      sdkVersion: "0.1.0",
      state: "hidden",
    } as AnyEvent);

    expect(onCustom).toHaveBeenCalledWith("level_up", { level: 3 }, 4);
    expect(onLifecycle).toHaveBeenCalledWith({ type: "visibility_change", state: "hidden" }, 5);
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
  const scalingSet = vi.fn();
  const node = {
    position: { set: positionSet },
    rotationQuaternion: { set: quaternionSet },
    scaling: { set: scalingSet },
  };
  return { node, positionSet, quaternionSet, scalingSet };
}

describe("createBabylonLiteReplayDriver — node_transform (ADR 0027)", () => {
  it("Tier 1: drives the node with the canonical transform applied verbatim (left-handed identity)", () => {
    const { node, positionSet, quaternionSet, scalingSet } = makeNode();
    const onNodeTransform = vi.fn();
    const driver = createBabylonLiteReplayDriver({
      camera: makeArcCamera(),
      nodes: { hero: node },
      onNodeTransform,
    });

    driver.apply(nodeEvent());

    // Lite shares the canonical frame → no Z-negation, no quaternion reflection.
    expect(positionSet).toHaveBeenCalledWith(1, 2, 3);
    expect(quaternionSet).toHaveBeenCalledWith(0.1, 0.2, 0.3, 0.9);
    expect(scalingSet).toHaveBeenCalledWith(2, 2, 2);
    expect(onNodeTransform.mock.calls[0]![1].position).toEqual([1, 2, 3]);
    expect(onNodeTransform.mock.calls[0]![1].rotation).toEqual([0.1, 0.2, 0.3, 0.9]);
    expect(onNodeTransform.mock.calls[0]![2]).toBe(10);
  });

  it("resolves a node via a () => node accessor and omits scale when absent", () => {
    const { node, positionSet, scalingSet } = makeNode();
    const driver = createBabylonLiteReplayDriver({
      camera: makeArcCamera(),
      nodes: { hero: () => node },
    });

    driver.apply(nodeEvent({ scale: undefined }));

    expect(positionSet).toHaveBeenCalledWith(1, 2, 3);
    expect(scalingSet).not.toHaveBeenCalled();
  });

  it("skips rotation when the node has no rotationQuaternion (Euler-mode mesh)", () => {
    const positionSet = vi.fn();
    const node = { position: { set: positionSet }, rotationQuaternion: null };
    const driver = createBabylonLiteReplayDriver({
      camera: makeArcCamera(),
      nodes: { hero: node },
    });

    expect(() => driver.apply(nodeEvent({ scale: undefined }))).not.toThrow();
    expect(positionSet).toHaveBeenCalledWith(1, 2, 3);
  });

  it("does not drive the node for a Tier-2 bone sample but still forwards it", () => {
    const { node, positionSet } = makeNode();
    const onNodeTransform = vi.fn();
    const driver = createBabylonLiteReplayDriver({
      camera: makeArcCamera(),
      nodes: { hero: node },
      onNodeTransform,
    });

    driver.apply(nodeEvent({ boneId: "Spine" }));

    expect(positionSet).not.toHaveBeenCalled();
    expect(onNodeTransform.mock.calls[0]![1].boneId).toBe("Spine");
  });

  it("ignores an unknown nodeId but still forwards the sample", () => {
    const onNodeTransform = vi.fn();
    const driver = createBabylonLiteReplayDriver({
      camera: makeArcCamera(),
      nodes: {},
      onNodeTransform,
    });

    expect(() => driver.apply(nodeEvent({ nodeId: "missing" }))).not.toThrow();
    expect(onNodeTransform).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no nodes map or callback is provided", () => {
    const driver = createBabylonLiteReplayDriver({ camera: makeArcCamera() });
    expect(() => driver.apply(nodeEvent())).not.toThrow();
  });
});
