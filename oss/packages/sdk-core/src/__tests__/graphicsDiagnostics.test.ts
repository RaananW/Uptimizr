import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireGpuDeviceLost, wireContextCreationFailure } from "../graphicsDiagnostics.js";
import type { CollectorContext, EventInput } from "../types.js";

/** Build a minimal ctx whose `emit` records into a sink, with a config override. */
function makeCtx(captureGraphicsDiagnostics: boolean) {
  const events: EventInput[] = [];
  const ctx = {
    config: { captureGraphicsDiagnostics } as never,
    sessionId: "s1",
    emit: (e: EventInput) => events.push(e),
    track: () => {},
    trackInput: () => {},
    reportCapabilityChange: () => {},
    setScene: () => {},
    createAggregation: () => () => {},
    now: () => 0,
  } as unknown as CollectorContext;
  return { ctx, events };
}

/** A device whose `lost` promise we resolve on demand. */
function makeDevice(info?: { reason?: string; message?: string }) {
  let resolve!: (v: { reason?: string; message?: string }) => void;
  const lost = new Promise<{ reason?: string; message?: string }>((r) => {
    resolve = r;
  });
  return {
    device: { lost },
    fire: () => {
      resolve(info ?? {});
      // Let the `.then` microtask run.
      return Promise.resolve();
    },
  };
}

describe("wireGpuDeviceLost", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits nothing when the opt-in flag is off", async () => {
    const { ctx, events } = makeCtx(false);
    const { device, fire } = makeDevice({ reason: "unknown" });
    wireGpuDeviceLost(
      ctx,
      () => device,
      () => true,
    );
    await fire();
    expect(events).toHaveLength(0);
  });

  it("emits one fatal device-lost diagnostic for an unrequested loss", async () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeDevice({ reason: "unknown", message: "GPU hang" });
    wireGpuDeviceLost(
      ctx,
      () => device,
      () => true,
    );
    await fire();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "graphics_diagnostic",
      severity: "fatal",
      category: "device-lost",
      backend: "webgpu",
      message: "GPU hang",
    });
  });

  it("maps reason 'destroyed' to info severity", async () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeDevice({ reason: "destroyed" });
    wireGpuDeviceLost(
      ctx,
      () => device,
      () => true,
    );
    await fire();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "graphics_diagnostic",
      severity: "info",
      category: "device-lost",
      backend: "webgpu",
    });
    // No message provided → field omitted entirely.
    expect(events[0]).not.toHaveProperty("message");
  });

  it("treats a missing reason as an unrequested (fatal) loss", async () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeDevice({});
    wireGpuDeviceLost(
      ctx,
      () => device,
      () => true,
    );
    await fire();
    expect(events[0]).toMatchObject({ severity: "fatal" });
  });

  it("truncates an over-long message to the schema cap (1024)", async () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeDevice({ reason: "unknown", message: "x".repeat(5000) });
    wireGpuDeviceLost(
      ctx,
      () => device,
      () => true,
    );
    await fire();
    expect((events[0] as { message: string }).message).toHaveLength(1024);
  });

  it("suppresses the emit when the collector has stopped", async () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeDevice({ reason: "unknown" });
    let active = true;
    wireGpuDeviceLost(
      ctx,
      () => device,
      () => active,
    );
    active = false; // tear down before the promise resolves
    await fire();
    expect(events).toHaveLength(0);
  });

  it("no-ops when there is never a device (WebGL path)", async () => {
    const { ctx, events } = makeCtx(true);
    wireGpuDeviceLost(
      ctx,
      () => undefined,
      () => true,
      { maxAttempts: 3, intervalMs: 10 },
    );
    wireGpuDeviceLost(
      ctx,
      () => null,
      () => true,
      { maxAttempts: 3, intervalMs: 10 },
    );
    wireGpuDeviceLost(
      ctx,
      () => ({}),
      () => true,
    ); // device without a `.lost` promise
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toHaveLength(0);
  });

  it("polls for an async-initialized device and wires it once it appears", async () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeDevice({ reason: "unknown", message: "late device" });
    // Device is undefined for the first two polls, then becomes available.
    let current: typeof device | undefined;
    let calls = 0;
    const getDevice = () => {
      calls += 1;
      if (calls > 2) current = device;
      return current;
    };

    wireGpuDeviceLost(ctx, getDevice, () => true, { maxAttempts: 10, intervalMs: 100 });
    // Not wired yet — no device for the initial synchronous poll.
    await fire();
    expect(events).toHaveLength(0);

    // Advance past two retry intervals so the device is picked up and attached.
    await vi.advanceTimersByTimeAsync(250);
    await fire();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: "fatal", category: "device-lost" });
  });

  it("stops polling once the collector is torn down before the device appears", async () => {
    const { ctx, events } = makeCtx(true);
    let active = true;
    let calls = 0;
    const getDevice = () => {
      calls += 1;
      return undefined; // device never becomes ready
    };
    wireGpuDeviceLost(ctx, getDevice, () => active, { maxAttempts: 50, intervalMs: 100 });

    active = false; // tear down after the first synchronous poll
    const callsAtStop = calls;
    await vi.advanceTimersByTimeAsync(1000);
    // No further polls happened after teardown, and nothing was emitted.
    expect(calls).toBe(callsAtStop);
    expect(events).toHaveLength(0);
  });
});

import { wireGpuUncapturedError } from "../graphicsDiagnostics.js";

class GPUValidationError {
  constructor(public message: string) {}
}
class GPUOutOfMemoryError {
  constructor(public message: string) {}
}

/** A device that records its `uncapturederror` listener so tests can fire errors. */
function makeErrorDevice() {
  let handler: ((e: { error?: unknown }) => void) | undefined;
  return {
    device: {
      addEventListener: (_t: string, h: (e: { error?: unknown }) => void) => (handler = h),
      removeEventListener: () => (handler = undefined),
    },
    fire: (error: unknown) => handler?.({ error }),
  };
}

describe("wireGpuUncapturedError", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits nothing when the opt-in flag is off", () => {
    const { ctx, events } = makeCtx(false);
    const { device, fire } = makeErrorDevice();
    const stop = wireGpuUncapturedError(
      ctx,
      () => device,
      () => true,
    );
    fire(new GPUValidationError("boom"));
    stop();
    expect(events).toHaveLength(0);
  });

  it("collapses a burst into ONE bounded rollup with count, not N events", () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeErrorDevice();
    const stop = wireGpuUncapturedError(
      ctx,
      () => device,
      () => true,
    );
    for (let i = 0; i < 50; i++) fire(new GPUValidationError(`err ${i}`));
    stop();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "graphics_diagnostic",
      severity: "warning",
      category: "validation",
      backend: "webgpu",
      count: 50,
      message: "err 0",
    });
  });

  it("maps GPUOutOfMemoryError to out-of-memory/error, keeping the first message", () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeErrorDevice();
    const stop = wireGpuUncapturedError(
      ctx,
      () => device,
      () => true,
    );
    fire(new GPUValidationError("v"));
    fire(new GPUOutOfMemoryError("oom"));
    stop();
    expect(events[0]).toMatchObject({
      category: "out-of-memory",
      severity: "error",
      count: 2,
      message: "v",
    });
  });

  it("truncates the first message to the schema cap (1024)", () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeErrorDevice();
    const stop = wireGpuUncapturedError(
      ctx,
      () => device,
      () => true,
    );
    fire(new GPUValidationError("x".repeat(5000)));
    stop();
    expect((events[0] as { message: string }).message).toHaveLength(1024);
  });

  it("flushes on a mid-session interval", async () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeErrorDevice();
    wireGpuUncapturedError(
      ctx,
      () => device,
      () => true,
      { flushIntervalMs: 1000 },
    );
    fire(new GPUValidationError("a"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ count: 1 });
  });

  it("flushes the remaining rollup on stop", () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeErrorDevice();
    const stop = wireGpuUncapturedError(
      ctx,
      () => device,
      () => true,
      { flushIntervalMs: 999999 },
    );
    fire(new GPUValidationError("a"));
    expect(events).toHaveLength(0);
    stop();
    expect(events).toHaveLength(1);
  });

  it("no-ops on WebGL (no device ever appears)", async () => {
    const { ctx, events } = makeCtx(true);
    const stop = wireGpuUncapturedError(
      ctx,
      () => undefined,
      () => true,
      { maxAttempts: 3, intervalMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(100);
    stop();
    expect(events).toHaveLength(0);
  });

  it("ignores errors after teardown (isActive false)", () => {
    const { ctx, events } = makeCtx(true);
    const { device, fire } = makeErrorDevice();
    let active = true;
    const stop = wireGpuUncapturedError(
      ctx,
      () => device,
      () => active,
    );
    active = false;
    fire(new GPUValidationError("late"));
    stop();
    expect(events).toHaveLength(0);
  });
});

describe("wireContextCreationFailure", () => {
  it("emits nothing when the opt-in flag is off, even on failure", () => {
    const { ctx, events } = makeCtx(false);
    wireContextCreationFailure(ctx, { failed: true, backend: "webgl2" });
    expect(events).toHaveLength(0);
  });

  it("emits nothing when context creation succeeded", () => {
    const { ctx, events } = makeCtx(true);
    wireContextCreationFailure(ctx, { failed: false });
    expect(events).toHaveLength(0);
  });

  it("emits one fatal context-loss marker on failure (no count)", () => {
    const { ctx, events } = makeCtx(true);
    wireContextCreationFailure(ctx, { failed: true, backend: "webgl2", message: "no GL" });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "graphics_diagnostic",
      severity: "fatal",
      category: "context-loss",
      backend: "webgl2",
      message: "no GL",
    });
    expect(events[0]).not.toHaveProperty("count");
  });

  it("defaults backend to 'unknown' when undetermined", () => {
    const { ctx, events } = makeCtx(true);
    wireContextCreationFailure(ctx, { failed: true });
    expect(events[0]).toEqual({
      type: "graphics_diagnostic",
      severity: "fatal",
      category: "context-loss",
      backend: "unknown",
    });
  });

  it("truncates an over-long message to the schema cap (1024)", () => {
    const { ctx, events } = makeCtx(true);
    wireContextCreationFailure(ctx, { failed: true, message: "x".repeat(5000) });
    expect((events[0] as { message: string }).message).toHaveLength(1024);
  });
});
