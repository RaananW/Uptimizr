import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  wireGpuDeviceLost,
  wireContextCreationFailure,
  wireGpuUncapturedError,
  wireGlShaderDiagnostics,
  wireGpuShaderDiagnostics,
  wireGlErrorSampling,
  buildShaderCompileDiagnostic,
} from "../graphicsDiagnostics.js";
import type {
  WebGlShaderContextLike,
  WebGpuShaderDeviceLike,
  WebGlErrorContextLike,
} from "../graphicsDiagnostics.js";
import type { CollectorContext, EventInput } from "../types.js";

/** Build a minimal ctx whose `emit` records into a sink, with a config override. */
function makeCtx(captureGraphicsDiagnostics: boolean, captureShaderSource = false) {
  const events: EventInput[] = [];
  const ctx = {
    config: { captureGraphicsDiagnostics, captureShaderSource } as never,
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

/** A fake WebGL context with controllable compile/link status. */
function makeGl(opts?: {
  compileOk?: boolean;
  linkOk?: boolean;
  infoLog?: string;
  source?: string;
}) {
  const calls = { compileShader: 0, linkProgram: 0 };
  const gl = {
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    compileShader: () => {
      calls.compileShader += 1;
    },
    linkProgram: () => {
      calls.linkProgram += 1;
    },
    getShaderParameter: () => opts?.compileOk ?? true,
    getProgramParameter: () => opts?.linkOk ?? true,
    getShaderInfoLog: () => opts?.infoLog ?? "info log",
    getProgramInfoLog: () => opts?.infoLog ?? "link failed",
    getShaderSource: () => opts?.source ?? "void main(){}",
  } satisfies WebGlShaderContextLike;
  return { gl, calls };
}

describe("buildShaderCompileDiagnostic", () => {
  it("omits raw source by default", () => {
    const e = buildShaderCompileDiagnostic({
      infoLog: "ERROR: bad",
      source: "secret-shader-ip",
      backend: "webgl2",
      captureShaderSource: false,
    });
    expect(e).toEqual({
      type: "graphics_diagnostic",
      severity: "error",
      category: "shader-compile",
      backend: "webgl2",
      message: "ERROR: bad",
    });
    expect(e.message).not.toContain("secret-shader-ip");
  });

  it("includes raw source only when opted in", () => {
    const e = buildShaderCompileDiagnostic({
      infoLog: "ERROR: bad",
      source: "secret-shader-ip",
      backend: "webgl2",
      captureShaderSource: true,
    });
    expect(e.message).toContain("secret-shader-ip");
  });

  it("caps message length to the schema limit", () => {
    const e = buildShaderCompileDiagnostic({
      infoLog: "x".repeat(5000),
      captureShaderSource: false,
    });
    expect((e.message ?? "").length).toBe(1024);
  });
});

describe("wireGlShaderDiagnostics", () => {
  it("emits nothing when the opt-in flag is off", () => {
    const { ctx, events } = makeCtx(false);
    const { gl } = makeGl({ linkOk: false });
    wireGlShaderDiagnostics(ctx, gl, () => true);
    gl.linkProgram({});
    expect(events).toHaveLength(0);
  });

  it("emits a shader-compile diagnostic on link failure, source redacted by default", () => {
    const { ctx, events } = makeCtx(true);
    const { gl } = makeGl({ linkOk: false, infoLog: "LINK ERROR" });
    wireGlShaderDiagnostics(ctx, gl, () => true);
    gl.linkProgram({});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "shader-compile",
      severity: "error",
      message: "LINK ERROR",
    });
  });

  it("embeds source on compile failure only when the sub-opt-in is set", () => {
    const on = makeCtx(true, true);
    const { gl } = makeGl({ compileOk: false, infoLog: "C", source: "MY_SRC" });
    wireGlShaderDiagnostics(on.ctx, gl, () => true);
    gl.compileShader({});
    expect((on.events[0] as { message: string }).message).toContain("MY_SRC");

    const off = makeCtx(true, false);
    const g2 = makeGl({ compileOk: false, infoLog: "C", source: "MY_SRC" });
    wireGlShaderDiagnostics(off.ctx, g2.gl, () => true);
    g2.gl.compileShader({});
    expect((off.events[0] as { message: string }).message).not.toContain("MY_SRC");
  });

  it("does not emit on success and detach restores methods", () => {
    const { ctx, events } = makeCtx(true);
    const { gl, calls } = makeGl({ linkOk: true });
    const detach = wireGlShaderDiagnostics(ctx, gl, () => true);
    gl.linkProgram({});
    detach();
    gl.linkProgram({});
    expect(events).toHaveLength(0);
    expect(calls.linkProgram).toBe(2);
  });
});

describe("wireGpuShaderDiagnostics", () => {
  it("emits a shader-compile diagnostic for WebGPU compilation errors", async () => {
    const { ctx, events } = makeCtx(true);
    const device = {
      createShaderModule: () => ({
        getCompilationInfo: async () => ({ messages: [{ type: "error", message: "wgsl bad" }] }),
      }),
    } satisfies WebGpuShaderDeviceLike;
    wireGpuShaderDiagnostics(ctx, device, () => true);
    device.createShaderModule({ code: "fn main(){}" });
    await Promise.resolve();
    await Promise.resolve();
    expect(events[0]).toMatchObject({
      category: "shader-compile",
      backend: "webgpu",
      message: "wgsl bad",
    });
  });
});

describe("wireGlErrorSampling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never reads getError synchronously (not per-frame)", () => {
    const { ctx } = makeCtx(true);
    let reads = 0;
    const gl: WebGlErrorContextLike = { getError: () => (reads++, 0) };
    wireGlErrorSampling(ctx, gl, () => true, { intervalMs: 1000 });
    expect(reads).toBe(0); // nothing sampled until the timer fires
  });

  it("rolls up sampled errors into one count-bearing diagnostic", () => {
    const { ctx, events } = makeCtx(true);
    const codes = [0x500, 0x501, 0];
    const gl: WebGlErrorContextLike = { getError: () => codes.shift() ?? 0 };
    wireGlErrorSampling(ctx, gl, () => true, { intervalMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "validation",
      severity: "warning",
      count: 2,
      code: "0x500",
    });
  });

  it("emits nothing when off and stops on detach", () => {
    const off = makeCtx(false);
    const gl: WebGlErrorContextLike = { getError: () => 0x500 };
    const noop = wireGlErrorSampling(off.ctx, gl, () => true, { intervalMs: 1000 });
    vi.advanceTimersByTime(3000);
    expect(off.events).toHaveLength(0);
    noop();
  });
});
