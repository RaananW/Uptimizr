import { describe, expect, it, vi } from "vitest";
import type { CollectorContext } from "@uptimizr/sdk-core";

import {
  babylonArPlacementCollector,
  classifyArSurface,
  type ArPlaceCandidate,
  type ArPlacementSettleInput,
  type ArPlacementStart,
  type ArHitResultLike,
} from "../arPlacement.js";

// A structural fake of a Babylon `Observable<T>`: records handlers and can `fire`.
function fakeObservable<T>() {
  const handlers: Array<(e: T) => void> = [];
  return {
    handlers,
    add: vi.fn((cb: (e: T) => void) => {
      handlers.push(cb);
      return cb;
    }),
    remove: vi.fn((observer: unknown) => {
      const i = handlers.indexOf(observer as (e: T) => void);
      if (i >= 0) handlers.splice(i, 1);
      return i >= 0;
    }),
    fire: (e: T) => handlers.slice().forEach((h) => h(e)),
  };
}

function makeCtx(nowValues: number[] = [0]) {
  const emit = vi.fn();
  let i = 0;
  const now = () => nowValues[Math.min(i++, nowValues.length - 1)] ?? 0;
  const ctx = {
    config: {} as CollectorContext["config"],
    sessionId: "sess_test",
    emit,
    track: vi.fn(),
    trackInput: vi.fn(),
    reportCapabilityChange: vi.fn(),
    setScene: vi.fn(),
    setPositionProvider: vi.fn(),
    now,
  } as unknown as CollectorContext;
  return { ctx, emit };
}

describe("classifyArSurface (ADR 0048 §1)", () => {
  it("maps an up-facing normal at floor height to floor", () => {
    expect(classifyArSurface({ x: 0, y: 1, z: 0 }, 0)).toBe("floor");
  });

  it("maps an up-facing normal at desk height to table", () => {
    expect(classifyArSurface({ x: 0, y: 1, z: 0 }, 0.75)).toBe("table");
  });

  it("maps a horizontal normal to wall regardless of height", () => {
    expect(classifyArSurface({ x: 1, y: 0, z: 0 }, 1.5)).toBe("wall");
  });

  it("maps a down-facing normal to ceiling", () => {
    expect(classifyArSurface({ x: 0, y: -1, z: 0 }, 2.4)).toBe("ceiling");
  });

  it("returns unknown for a missing normal or an ambiguous tilt", () => {
    expect(classifyArSurface(undefined)).toBe("unknown");
    expect(classifyArSurface({ x: 0, y: 0.5, z: 0.87 })).toBe("unknown");
  });

  it("accepts a canonical [x, y, z] tuple", () => {
    expect(classifyArSurface([0, 1, 0], 0)).toBe("floor");
  });
});

describe("babylonArPlacementCollector (#156, ADR 0048)", () => {
  it("emits one ar_placement per settle with attempts, time-to-place, and surface", () => {
    const onPlacementStartObservable = fakeObservable<ArPlacementStart>();
    const onPlaceObservable = fakeObservable<ArPlaceCandidate>();
    const onSettleObservable = fakeObservable<ArPlacementSettleInput>();
    // now(): start=1000, settle=4200 → timeToPlaceMs 3200.
    const { ctx, emit } = makeCtx([1000, 4200]);

    const collector = babylonArPlacementCollector({
      onPlacementStartObservable,
      onPlaceObservable,
      onSettleObservable,
    });
    const handle = collector.start(ctx);

    onPlacementStartObservable.fire({ mesh: "Sofa" });
    onPlaceObservable.fire({ position: { x: 1, y: 0, z: 2 }, normal: { x: 0, y: 1, z: 0 } });
    onPlaceObservable.fire({ position: { x: 1.2, y: 0, z: 2.1 }, normal: { x: 0, y: 1, z: 0 } });
    onSettleObservable.fire({ position: { x: 1.2, y: 0, z: 2.1 }, scale: 0.8, final: true });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: "ar_placement",
      mesh: "Sofa",
      position: [1.2, 0, 2.1],
      surface: "floor",
      attempts: 2,
      timeToPlaceMs: 3200,
      scale: 0.8,
      final: true,
    });

    (handle as { stop(): void }).stop();
  });

  it("defaults attempts to 1 and scale to 1 when a settle has no prior place", () => {
    const onSettleObservable = fakeObservable<ArPlacementSettleInput>();
    const { ctx, emit } = makeCtx([500, 500]);
    const collector = babylonArPlacementCollector({ onSettleObservable, mesh: "Chair" });
    collector.start(ctx);

    onSettleObservable.fire({ position: [0, 0, 0], surface: "table" });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ar_placement",
        mesh: "Chair",
        attempts: 1,
        scale: 1,
        surface: "table",
        final: false,
      }),
    );
  });

  it("classifies the surface from the latest hit-test result when a place omits a normal", () => {
    const onPlaceObservable = fakeObservable<ArPlaceCandidate>();
    const onSettleObservable = fakeObservable<ArPlacementSettleInput>();
    const onHitTestResultObservable = fakeObservable<ArHitResultLike[]>();
    const { ctx, emit } = makeCtx([0, 100]);

    const collector = babylonArPlacementCollector({
      onPlaceObservable,
      onSettleObservable,
      hitTest: { onHitTestResultObservable },
    });
    collector.start(ctx);

    // A vertical plane (wall) reported by hit-test, then a place without a normal.
    onHitTestResultObservable.fire([{ position: { x: 0, y: 1.4, z: 0 }, normal: { x: 1, y: 0, z: 0 } }]);
    onPlaceObservable.fire({ position: { x: 0, y: 1.4, z: 0 } });
    onSettleObservable.fire({});

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ar_placement", surface: "wall", attempts: 1 }),
    );
  });

  it("removes every observer on stop so nothing fires afterwards", () => {
    const onPlacementStartObservable = fakeObservable<ArPlacementStart>();
    const onPlaceObservable = fakeObservable<ArPlaceCandidate>();
    const onSettleObservable = fakeObservable<ArPlacementSettleInput>();
    const { ctx, emit } = makeCtx();

    const collector = babylonArPlacementCollector({
      onPlacementStartObservable,
      onPlaceObservable,
      onSettleObservable,
    });
    const handle = collector.start(ctx);
    (handle as { stop(): void }).stop();

    expect(onPlacementStartObservable.handlers).toHaveLength(0);
    expect(onPlaceObservable.handlers).toHaveLength(0);
    expect(onSettleObservable.handlers).toHaveLength(0);

    // Firing after stop is a no-op (handlers were removed).
    onSettleObservable.fire({ position: [0, 0, 0] });
    expect(emit).not.toHaveBeenCalled();
  });

  it("treats a second settle as its own placement (fresh attempts + timer)", () => {
    const onPlaceObservable = fakeObservable<ArPlaceCandidate>();
    const onSettleObservable = fakeObservable<ArPlacementSettleInput>();
    // start1=0, settle1=1000, start2(place)=2000, settle2=2500
    const { ctx, emit } = makeCtx([0, 1000, 2000, 2500]);
    const collector = babylonArPlacementCollector({ onPlaceObservable, onSettleObservable });
    collector.start(ctx);

    onPlaceObservable.fire({ position: [0, 0, 0], surface: "floor" });
    onSettleObservable.fire({ final: false });
    onPlaceObservable.fire({ position: [1, 0, 1], surface: "floor" });
    onSettleObservable.fire({ final: true });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1][0]).toMatchObject({ attempts: 1, timeToPlaceMs: 500, final: true });
  });
});
