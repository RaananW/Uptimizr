import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectorContext, EventInput } from "@uptimizr/sdk-core";
import { startJsOnlyCapture } from "../jsOnly.js";

function makeCanvas() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  return {
    listeners,
    addEventListener(type: string, h: (e: unknown) => void) {
      (listeners[type] ??= []).push(h);
    },
    removeEventListener(type: string, h: (e: unknown) => void) {
      listeners[type] = (listeners[type] ?? []).filter((cb) => cb !== h);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    dispatch(type: string, ev: unknown) {
      for (const cb of [...(listeners[type] ?? [])]) cb(ev);
    },
    count(type: string) {
      return (listeners[type] ?? []).length;
    },
  };
}

function makeCtx(now = { value: 1000 }) {
  const events: EventInput[] = [];
  const ctx = {
    config: {} as never,
    sessionId: "s1",
    emit: (e: EventInput) => events.push(e),
    track: () => {},
    trackInput: () => {},
    reportCapabilityChange: () => {},
    setScene: () => {},
    createAggregation: () => () => {},
    now: () => now.value,
  } as unknown as CollectorContext;
  return { ctx, events, now };
}

describe("startJsOnlyCapture — pointer tier", () => {
  it("emits a normalized top-left screen pointer_move", () => {
    const { ctx, events } = makeCtx();
    const canvas = makeCanvas();
    const stop = startJsOnlyCapture({ ctx, canvas, capture: { perf: false, errors: false } });
    canvas.dispatch("pointermove", { clientX: 400, clientY: 300 });
    expect(events).toEqual([{ type: "pointer_move", screen: [0.5, 0.5] }]);
    stop();
    expect(canvas.count("pointermove")).toBe(0);
  });

  it("throttles pointer_move by pointerMoveThrottleMs", () => {
    const now = { value: 1000 };
    const { ctx, events } = makeCtx(now);
    const canvas = makeCanvas();
    startJsOnlyCapture({
      ctx,
      canvas,
      pointerMoveThrottleMs: 250,
      capture: { perf: false, errors: false },
    });
    canvas.dispatch("pointermove", { clientX: 0, clientY: 0 });
    now.value = 1100; // < 250ms later
    canvas.dispatch("pointermove", { clientX: 800, clientY: 600 });
    now.value = 1300; // >= 250ms after the first
    canvas.dispatch("pointermove", { clientX: 800, clientY: 600 });
    expect(events).toHaveLength(2);
  });

  it("emits pointer_click with button", () => {
    const { ctx, events } = makeCtx();
    const canvas = makeCanvas();
    startJsOnlyCapture({ ctx, canvas, capture: { perf: false, errors: false } });
    canvas.dispatch("click", { clientX: 0, clientY: 0, button: 0 });
    expect(events).toEqual([{ type: "pointer_click", screen: [0, 0], button: 0 }]);
  });

  it("does not register pointer listeners when channels are off", () => {
    const { ctx } = makeCtx();
    const canvas = makeCanvas();
    startJsOnlyCapture({
      ctx,
      canvas,
      capture: { pointerMove: false, clicks: false, buttons: false, perf: false, errors: false },
    });
    expect(canvas.count("pointermove")).toBe(0);
    expect(canvas.count("click")).toBe(0);
  });
});

describe("startJsOnlyCapture — rAF perf tier", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(performance.now()), 16) as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      clearTimeout(id as unknown as NodeJS.Timeout),
    );
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("emits a frame_perf after the perf window elapses", () => {
    const now = { value: 0 };
    const { ctx, events } = makeCtx(now);
    const stop = startJsOnlyCapture({
      ctx,
      perfWindowMs: 100,
      jankFrameMs: 50,
      capture: { pointerMove: false, clicks: false, buttons: false, errors: true },
    });
    // Advance several rAF ticks, moving the collector clock forward 20ms/frame.
    for (let i = 0; i < 8; i++) {
      now.value += 20;
      vi.advanceTimersByTime(16);
    }
    const perf = events.find((e) => e.type === "frame_perf");
    expect(perf).toBeDefined();
    expect((perf as { fps: number }).fps).toBeGreaterThan(0);
    stop();
  });
});

describe("startJsOnlyCapture — error tier", () => {
  it("maps a window error event to runtime_error", () => {
    const { ctx, events } = makeCtx();
    const stop = startJsOnlyCapture({
      ctx,
      capture: { pointerMove: false, clicks: false, buttons: false, perf: false, errors: true },
    });
    dispatchEvent(
      Object.assign(new Event("error"), {
        message: "boom",
        filename: "app.js",
        lineno: 12,
        colno: 3,
      }),
    );
    const err = events.find((e) => e.type === "runtime_error");
    expect(err).toMatchObject({
      type: "runtime_error",
      kind: "error",
      message: "boom",
      source: "app.js",
      lineno: 12,
      colno: 3,
    });
    stop();
  });
});
