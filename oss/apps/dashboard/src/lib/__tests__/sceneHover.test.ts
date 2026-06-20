import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachMeshHover, type HoverTip } from "../sceneHover";

// `attachMeshHover` only touches a few DOM/Babylon surfaces (canvas listeners,
// requestAnimationFrame, scene.pick), so we drive it with duck-typed fakes in
// the default node env — no jsdom needed. The rAF callback is captured and
// flushed manually so the pick → onChange path is deterministic.

type Listener = (ev: { offsetX: number; offsetY: number }) => void;

interface FakeMesh {
  isPickable: boolean;
  isEnabled: () => boolean;
  metadata: unknown;
}

interface FakePick {
  pickedMesh: FakeMesh | null;
  thinInstanceIndex?: number;
}

function fakeMesh(metadata: unknown): FakeMesh {
  return { isPickable: true, isEnabled: () => true, metadata };
}

describe("attachMeshHover", () => {
  let listeners: Record<string, Listener>;
  let canvas: HTMLCanvasElement;
  let rafCb: FrameRequestCallback | null;
  let pickResult: FakePick | null;
  let pickArgs: Array<{ x: number; y: number }>;
  let scene: {
    pick: (x: number, y: number, predicate: (m: FakeMesh) => boolean) => FakePick | null;
  };
  let tips: Array<HoverTip | null>;

  beforeEach(() => {
    listeners = {};
    canvas = {
      addEventListener: (type: string, h: Listener) => {
        listeners[type] = h;
      },
      removeEventListener: (type: string, h: Listener) => {
        if (listeners[type] === h) delete listeners[type];
      },
    } as unknown as HTMLCanvasElement;

    rafCb = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      rafCb = null;
    });

    pickResult = null;
    pickArgs = [];
    scene = {
      pick: (x: number, y: number, predicate: (m: FakeMesh) => boolean) => {
        pickArgs.push({ x, y });
        // Honor the pickable/enabled predicate the helper passes in.
        if (pickResult?.pickedMesh && !predicate(pickResult.pickedMesh))
          return { pickedMesh: null };
        return pickResult;
      },
    };

    tips = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Dispatch a pointermove and flush the scheduled rAF pick. */
  function move(x: number, y: number) {
    listeners.pointermove?.({ offsetX: x, offsetY: y });
    rafCb?.(0);
  }

  function attach() {
    return attachMeshHover(scene as never, canvas, (tip) => tips.push(tip));
  }

  it("reports the whole-mesh hoverLabel at the pointer position", () => {
    attach();
    pickResult = { pickedMesh: fakeMesh({ hoverLabel: "box-1" }), thinInstanceIndex: -1 };

    move(42, 17);

    expect(tips).toEqual([{ label: "box-1", x: 42, y: 17 }]);
    expect(pickArgs).toEqual([{ x: 42, y: 17 }]);
  });

  it("resolves per-thin-instance labels by thinInstanceIndex", () => {
    attach();
    pickResult = {
      pickedMesh: fakeMesh({ hoverLabels: ["floor", "wall", "door"] }),
      thinInstanceIndex: 2,
    };

    move(5, 5);

    expect(tips).toEqual([{ label: "door", x: 5, y: 5 }]);
  });

  it("does not emit when the picked mesh has no resolvable label", () => {
    attach();
    pickResult = { pickedMesh: fakeMesh({ hoverLabels: ["a"] }), thinInstanceIndex: 9 };

    move(1, 1);

    expect(tips).toEqual([]);
  });

  it("clears the tip when moving from a labelled mesh onto empty space", () => {
    attach();
    pickResult = { pickedMesh: fakeMesh({ hoverLabel: "lamp" }), thinInstanceIndex: -1 };
    move(10, 10);

    pickResult = null; // empty space
    move(200, 200);

    expect(tips).toEqual([{ label: "lamp", x: 10, y: 10 }, null]);
  });

  it("clears the tip on pointerleave after a label was shown", () => {
    attach();
    pickResult = { pickedMesh: fakeMesh({ hoverLabel: "door" }), thinInstanceIndex: -1 };
    move(7, 8);

    listeners.pointerleave?.({ offsetX: 0, offsetY: 0 });

    expect(tips).toEqual([{ label: "door", x: 7, y: 8 }, null]);
  });

  it("does not emit a redundant null on pointerleave when nothing was shown", () => {
    attach();
    listeners.pointerleave?.({ offsetX: 0, offsetY: 0 });
    expect(tips).toEqual([]);
  });

  it("removes its listeners on dispose so later moves are ignored", () => {
    const detach = attach();
    pickResult = { pickedMesh: fakeMesh({ hoverLabel: "box-1" }), thinInstanceIndex: -1 };

    detach();
    expect(listeners.pointermove).toBeUndefined();
    expect(listeners.pointerleave).toBeUndefined();

    // A move after dispose can't reach the handler and yields no tips.
    move(3, 3);
    expect(tips).toEqual([]);
  });
});
