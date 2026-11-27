import { afterEach, describe, it, expect, vi } from "vitest";
import { anyEventSchema, LIMITS, type CollectRequest } from "@uptimizr/schema";
import { UptimizrClient } from "../client.js";
import type { Collector, EventInput, Transport } from "../types.js";

function mockTransport() {
  const batches: CollectRequest[] = [];
  let ok = true;
  const transport: Transport = {
    send: async (batch) => {
      batches.push(batch);
      return ok;
    },
  };
  return {
    transport,
    batches,
    setOk: (v: boolean) => {
      ok = v;
    },
  };
}

const baseConfig = (transport: Transport) => ({
  projectId: "proj_demo",
  endpoint: "https://collect.test",
  transport,
  flushIntervalMs: 0, // disable timer; flush manually in tests
  batchSize: 1000, // disable size-based auto-flush unless overridden
});

describe("UptimizrClient", () => {
  it("emits a schema-valid session_start on start and flushes it", async () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    await client.flush();

    expect(m.batches).toHaveLength(1);
    const [batch] = m.batches;
    const event = batch!.events[0]!;
    expect(event.type).toBe("session_start");
    // Envelope filled by the client.
    expect(event.projectId).toBe("proj_demo");
    expect(event.sessionId).toBe(client.sessionId);
    expect(event.sdkVersion).toBeTruthy();
    expect(typeof event.ts).toBe("number");
    // Round-trips through the canonical schema.
    expect(anyEventSchema.safeParse(event).success).toBe(true);
  });

  it("does nothing before start or when disabled", async () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    client.emit({ type: "custom", name: "early" });
    await client.flush();
    expect(m.batches).toHaveLength(0);

    const disabled = new UptimizrClient({ ...baseConfig(m.transport), disabled: true });
    disabled.start();
    disabled.track("nope");
    await disabled.flush();
    expect(m.batches).toHaveLength(0);
  });

  it("defaults captureGraphicsDiagnostics to false (opt-in, ADR 0021)", () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    expect(client.config.captureGraphicsDiagnostics).toBe(false);

    const optedIn = new UptimizrClient({
      ...baseConfig(m.transport),
      captureGraphicsDiagnostics: true,
    });
    expect(optedIn.config.captureGraphicsDiagnostics).toBe(true);
  });

  it("defaults captureShaderSource to false (sub-opt-in, IP risk, ADR 0021)", () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    expect(client.config.captureShaderSource).toBe(false);

    const optedIn = new UptimizrClient({
      ...baseConfig(m.transport),
      captureShaderSource: true,
    });
    expect(optedIn.config.captureShaderSource).toBe(true);
  });

  it("auto-flushes when the batch size threshold is reached", async () => {
    const m = mockTransport();
    const client = new UptimizrClient({ ...baseConfig(m.transport), batchSize: 2 });
    client.start(); // emits session_start (1)
    client.track("second"); // reaches 2 -> auto-flush
    await vi.waitFor(() => expect(m.batches.length).toBeGreaterThanOrEqual(1));
    const total = m.batches.reduce((n, b) => n + b.events.length, 0);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("emits a schema-valid input_action via trackInput, defaulting source to keyboard", async () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    client.trackInput("next-camera", { code: "KeyN", pressed: true });
    client.trackInput("jump", { source: "gamepad", button: 0 });
    await client.flush();

    const inputs = m.batches.flatMap((b) => b.events).filter((e) => e.type === "input_action");
    expect(inputs).toHaveLength(2);
    for (const event of inputs) {
      expect(anyEventSchema.safeParse(event).success).toBe(true);
    }
    const [kb, gp] = inputs as Array<Extract<(typeof inputs)[number], { type: "input_action" }>>;
    expect(kb!.action).toBe("next-camera");
    expect(kb!.source).toBe("keyboard");
    expect(kb!.code).toBe("KeyN");
    expect(kb!.pressed).toBe(true);
    expect(gp!.source).toBe("gamepad");
    expect(gp!.button).toBe(0);
  });

  it("ignores a trackInput call with an empty action", async () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    client.trackInput("");
    await client.flush();
    const inputs = m.batches.flatMap((b) => b.events).filter((e) => e.type === "input_action");
    expect(inputs).toHaveLength(0);
  });

  it("emits a schema-valid capability_change via reportCapabilityChange (#49)", async () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    client.reportCapabilityChange({
      kind: "graphics-backend",
      from: "webgpu",
      to: "webgl2",
      reason: "device-init-failed",
    });
    client.reportCapabilityChange({ kind: "device-recovery" });
    await client.flush();

    const changes = m.batches
      .flatMap((b) => b.events)
      .filter((e) => e.type === "capability_change");
    expect(changes).toHaveLength(2);
    for (const event of changes) {
      expect(anyEventSchema.safeParse(event).success).toBe(true);
    }
    const [backend, recovery] = changes as Array<
      Extract<(typeof changes)[number], { type: "capability_change" }>
    >;
    expect(backend!.kind).toBe("graphics-backend");
    expect(backend!.from).toBe("webgpu");
    expect(backend!.to).toBe("webgl2");
    expect(backend!.reason).toBe("device-init-failed");
    // Optional tokens are omitted, not sent as empty strings.
    expect(recovery!.kind).toBe("device-recovery");
    expect(recovery!.from).toBeUndefined();
    expect(recovery!.to).toBeUndefined();
  });

  it("ignores a reportCapabilityChange call with no kind (#49)", async () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    // @ts-expect-error — kind is required; this guards the runtime early-return.
    client.reportCapabilityChange({ from: "webgpu", to: "webgl2" });
    await client.flush();
    const changes = m.batches
      .flatMap((b) => b.events)
      .filter((e) => e.type === "capability_change");
    expect(changes).toHaveLength(0);
  });

  it("re-queues events when the transport fails", async () => {
    const m = mockTransport();
    m.setOk(false);
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    await client.flush(); // fails -> re-queued
    expect(m.batches).toHaveLength(1);

    m.setOk(true);
    await client.flush(); // succeeds, re-sends the same event
    expect(m.batches).toHaveLength(2);
    expect(m.batches[1]!.events[0]!.type).toBe("session_start");
  });

  it("runs a registered collector and tears it down on stop", async () => {
    const m = mockTransport();
    const stop = vi.fn();
    const started = vi.fn();
    const collector: Collector = {
      name: "test-collector",
      start: (ctx) => {
        started();
        ctx.emit({ type: "camera_sample", position: [0, 0, 0], direction: [0, 0, 1] });
        return { stop };
      },
    };
    const client = new UptimizrClient(baseConfig(m.transport)).use(collector);
    client.start();
    expect(started).toHaveBeenCalledOnce();

    await client.stop();
    expect(stop).toHaveBeenCalledOnce();

    const types = m.batches.flatMap((b) => b.events.map((e) => e.type));
    expect(types).toContain("camera_sample");
    expect(types).toContain("session_start");
    expect(types).toContain("session_end");
  });

  it("queues + flushes a context-creation marker emitted at collector init (#18)", async () => {
    const m = mockTransport();
    // A connector that detects a failed context and emits before any transport
    // round-trip — the marker must still land, ordered after session_start.
    const collector: Collector = {
      name: "context-fail",
      start: (ctx) => {
        ctx.emit({
          type: "graphics_diagnostic",
          severity: "fatal",
          category: "context-loss",
          backend: "unknown",
        });
      },
    };
    const client = new UptimizrClient({
      ...baseConfig(m.transport),
      captureGraphicsDiagnostics: true,
    }).use(collector);
    client.start();
    await client.flush();

    const types = m.batches.flatMap((b) => b.events.map((e) => e.type));
    expect(types).toEqual(["session_start", "graphics_diagnostic"]);
  });

  it("setScene emits a scene_change marker and stamps sceneId on later events", async () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    client.setScene("level-3");
    client.track("after");
    await client.flush();

    const events = m.batches.flatMap((b) => b.events);
    const change = events.find((e) => e.type === "scene_change");
    expect(change).toBeDefined();
    expect((change as { sceneId?: string }).sceneId).toBe("level-3");
    const after = events.find((e) => e.type === "custom");
    expect((after as { sceneId?: string }).sceneId).toBe("level-3");
    // session_start predates setScene -> no scene stamp.
    const start = events.find((e) => e.type === "session_start");
    expect((start as { sceneId?: string }).sceneId).toBeUndefined();
  });

  it("applies an initial sceneId from start() to session_start", async () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start({ sceneId: "lobby" });
    await client.flush();

    const start = m.batches.flatMap((b) => b.events).find((e) => e.type === "session_start");
    expect((start as { sceneId?: string }).sceneId).toBe("lobby");
  });

  it("ignores an invalid sceneId and emits no marker", async () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    client.setScene("not valid!");
    client.track("after");
    await client.flush();

    const events = m.batches.flatMap((b) => b.events);
    expect(events.some((e) => e.type === "scene_change")).toBe(false);
    const after = events.find((e) => e.type === "custom");
    expect((after as { sceneId?: string }).sceneId).toBeUndefined();
  });

  it("leaves events scene-less when setScene is never called", async () => {
    const m = mockTransport();
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    await client.flush();
    const start = m.batches.flatMap((b) => b.events).find((e) => e.type === "session_start");
    expect((start as { sceneId?: string }).sceneId).toBeUndefined();
  });
});

/** Install a minimal window/document on globalThis and return controls. */
function installFakeWindow(visibility: "visible" | "hidden" = "visible") {
  const listeners = new Map<string, Set<() => void>>();
  const g = globalThis as Record<string, unknown>;
  const saved = {
    addEventListener: g.addEventListener,
    removeEventListener: g.removeEventListener,
    document: g.document,
    innerWidth: g.innerWidth,
    innerHeight: g.innerHeight,
    devicePixelRatio: g.devicePixelRatio,
  };
  g.addEventListener = (type: string, cb: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(cb);
  };
  g.removeEventListener = (type: string, cb: () => void) => {
    listeners.get(type)?.delete(cb);
  };
  const doc = {
    visibilityState: visibility,
    addEventListener: g.addEventListener,
    removeEventListener: g.removeEventListener,
  };
  g.document = doc;
  g.innerWidth = 1280;
  g.innerHeight = 720;
  g.devicePixelRatio = 2;
  return {
    doc,
    counts: () => Object.fromEntries([...listeners].map(([k, v]) => [k, v.size])),
    fire: (type: string, event?: unknown) =>
      listeners.get(type)?.forEach((cb) => (cb as (e: unknown) => void)(event)),
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    },
  };
}

describe("UptimizrClient lifecycle capture", () => {
  it("emits an initial viewport_resize and tracks focus/blur and visibility", async () => {
    vi.useFakeTimers();
    const win = installFakeWindow();
    try {
      const m = mockTransport();
      const client = new UptimizrClient(baseConfig(m.transport));
      client.start();

      // Initial viewport sample on start.
      win.fire("focus"); // focused: true
      win.fire("blur"); // focused: false
      win.doc.visibilityState = "hidden";
      win.fire("visibilitychange"); // visibility_change hidden
      win.doc.visibilityState = "visible";
      win.fire("visibilitychange"); // visibility_change visible
      win.fire("resize"); // debounced
      vi.advanceTimersByTime(300);

      await client.flush();
      const events = m.batches.flatMap((b) => b.events);

      const resizes = events.filter((e) => e.type === "viewport_resize");
      expect(resizes.length).toBeGreaterThanOrEqual(2); // initial + debounced
      expect((resizes[0] as { width: number }).width).toBe(1280);
      expect((resizes[0] as { dpr?: number }).dpr).toBe(2);

      const focus = events.filter((e) => e.type === "focus_change");
      expect(focus.map((e) => (e as { focused: boolean }).focused)).toEqual([true, false]);

      const vis = events.filter((e) => e.type === "visibility_change");
      expect(vis.map((e) => (e as { state: string }).state)).toEqual(["hidden", "visible"]);

      for (const e of events) expect(anyEventSchema.safeParse(e).success).toBe(true);
    } finally {
      win.restore();
      vi.useRealTimers();
    }
  });

  it("debounces resize into a single viewport_resize", async () => {
    vi.useFakeTimers();
    const win = installFakeWindow();
    try {
      const m = mockTransport();
      const client = new UptimizrClient(baseConfig(m.transport));
      client.start();
      await client.flush(); // drains the initial sample
      m.batches.length = 0;

      win.fire("resize");
      win.fire("resize");
      win.fire("resize");
      vi.advanceTimersByTime(300);
      await client.flush();

      const resizes = m.batches
        .flatMap((b) => b.events)
        .filter((e) => e.type === "viewport_resize");
      expect(resizes).toHaveLength(1);
    } finally {
      win.restore();
      vi.useRealTimers();
    }
  });

  it("removes lifecycle listeners on stop", async () => {
    const win = installFakeWindow();
    try {
      const m = mockTransport();
      const client = new UptimizrClient(baseConfig(m.transport));
      client.start();
      expect(win.counts().resize).toBe(1);
      expect(win.counts().focus).toBe(1);
      await client.stop();
      expect(win.counts().resize ?? 0).toBe(0);
      expect(win.counts().focus ?? 0).toBe(0);
      expect(win.counts().visibilitychange ?? 0).toBe(0);
    } finally {
      win.restore();
    }
  });

  it("captures nothing extra when captureLifecycle is false", async () => {
    const win = installFakeWindow();
    try {
      const m = mockTransport();
      const client = new UptimizrClient({ ...baseConfig(m.transport), captureLifecycle: false });
      client.start();
      win.fire("focus");
      win.fire("resize");
      await client.flush();
      const events = m.batches.flatMap((b) => b.events);
      expect(events.some((e) => e.type === "viewport_resize")).toBe(false);
      expect(events.some((e) => e.type === "focus_change")).toBe(false);
    } finally {
      win.restore();
    }
  });

  it("does not capture errors by default", async () => {
    const win = installFakeWindow();
    try {
      const m = mockTransport();
      const client = new UptimizrClient(baseConfig(m.transport));
      client.start();
      expect(win.counts().error ?? 0).toBe(0);
      win.fire("error", { message: "boom" });
      await client.flush();
      expect(m.batches.flatMap((b) => b.events).some((e) => e.type === "runtime_error")).toBe(
        false,
      );
    } finally {
      win.restore();
    }
  });

  it("captures window.onerror and unhandledrejection when captureErrors is on", async () => {
    const win = installFakeWindow();
    try {
      const m = mockTransport();
      const client = new UptimizrClient({ ...baseConfig(m.transport), captureErrors: true });
      client.start();

      win.fire("error", {
        message: "boom",
        filename: "https://app.example/main.js",
        lineno: 42,
        colno: 7,
        error: new Error("boom"),
      });
      win.fire("unhandledrejection", { reason: new Error("nope") });

      await client.flush();
      const errors = m.batches.flatMap((b) => b.events).filter((e) => e.type === "runtime_error");
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatchObject({
        kind: "error",
        message: "boom",
        source: "https://app.example/main.js",
        lineno: 42,
        colno: 7,
      });
      expect((errors[0] as { stack?: string }).stack).toContain("boom");
      expect(errors[1]).toMatchObject({ kind: "unhandledrejection", message: "nope" });
      for (const e of errors) expect(anyEventSchema.safeParse(e).success).toBe(true);
    } finally {
      win.restore();
    }
  });

  it("dedupes consecutive identical errors and caps per session", async () => {
    const win = installFakeWindow();
    try {
      const m = mockTransport();
      const client = new UptimizrClient({ ...baseConfig(m.transport), captureErrors: true });
      client.start();

      const err = { message: "loop", error: new Error("loop") };
      for (let i = 0; i < 5; i++) win.fire("error", err); // identical → 1 kept
      // A different error breaks the dedupe run.
      win.fire("error", { message: "other", error: new Error("other") });
      // Fire 100 distinct errors to exercise the per-session cap (50).
      for (let i = 0; i < 100; i++) {
        win.fire("error", { message: `e${i}`, error: new Error(`e${i}`) });
      }

      await client.flush();
      const errors = m.batches.flatMap((b) => b.events).filter((e) => e.type === "runtime_error");
      expect(errors.length).toBe(50); // capped
      expect((errors[0] as { message: string }).message).toBe("loop");
      expect((errors[1] as { message: string }).message).toBe("other");
    } finally {
      win.restore();
    }
  });

  it("removes error listeners on stop", async () => {
    const win = installFakeWindow();
    try {
      const m = mockTransport();
      const client = new UptimizrClient({ ...baseConfig(m.transport), captureErrors: true });
      client.start();
      expect(win.counts().error).toBe(1);
      expect(win.counts().unhandledrejection).toBe(1);
      await client.stop();
      expect(win.counts().error ?? 0).toBe(0);
      expect(win.counts().unhandledrejection ?? 0).toBe(0);
    } finally {
      win.restore();
    }
  });
});

describe("position enrichment (#154)", () => {
  const errorConfig = (transport: Transport) => ({
    ...baseConfig(transport),
    captureGraphicsDiagnostics: true,
  });

  it("stamps the provider position on runtime_error and graphics_diagnostic", async () => {
    const m = mockTransport();
    const collector: Collector = {
      name: "positioned",
      start: (ctx) => {
        ctx.setPositionProvider(() => [1, 2, 3]);
        ctx.emit({ type: "graphics_diagnostic", severity: "error", category: "shader-compile" });
      },
    };
    const client = new UptimizrClient(errorConfig(m.transport)).use(collector);
    client.start();
    // A runtime_error emitted through the public API is enriched by the same seam.
    client.emit({ type: "runtime_error", kind: "error", message: "boom" });
    await client.flush();

    const events = m.batches.flatMap((b) => b.events);
    const diag = events.find((e) => e.type === "graphics_diagnostic")!;
    const err = events.find((e) => e.type === "runtime_error")!;
    expect((diag as { position?: number[] }).position).toEqual([1, 2, 3]);
    expect((err as { position?: number[] }).position).toEqual([1, 2, 3]);
    for (const e of events) expect(anyEventSchema.safeParse(e).success).toBe(true);
  });

  it("does not overwrite a position the connector already set", async () => {
    const m = mockTransport();
    const collector: Collector = {
      name: "explicit",
      start: (ctx) => {
        ctx.setPositionProvider(() => [9, 9, 9]);
        ctx.emit({
          type: "graphics_diagnostic",
          severity: "error",
          category: "validation",
          position: [4, 5, 6],
        });
      },
    };
    const client = new UptimizrClient(errorConfig(m.transport)).use(collector);
    client.start();
    await client.flush();

    const diag = m.batches.flatMap((b) => b.events).find((e) => e.type === "graphics_diagnostic")!;
    expect((diag as { position?: number[] }).position).toEqual([4, 5, 6]);
  });

  it("leaves non-spatial events and unprovided errors untouched", async () => {
    const m = mockTransport();
    const collector: Collector = {
      name: "no-provider",
      start: (ctx) => {
        // Provider returns undefined (no resolvable camera) → no position added.
        ctx.setPositionProvider(() => undefined);
        ctx.emit({ type: "graphics_diagnostic", severity: "info", category: "context-loss" });
        ctx.emit({ type: "custom", name: "click", props: { x: 1 } });
      },
    };
    const client = new UptimizrClient(errorConfig(m.transport)).use(collector);
    client.start();
    await client.flush();

    const events = m.batches.flatMap((b) => b.events);
    const diag = events.find((e) => e.type === "graphics_diagnostic")!;
    const custom = events.find((e) => e.type === "custom")!;
    expect((diag as { position?: number[] }).position).toBeUndefined();
    expect((custom as { position?: number[] }).position).toBeUndefined();
  });

  it("swallows a throwing provider and still emits", async () => {
    const m = mockTransport();
    const collector: Collector = {
      name: "throwing",
      start: (ctx) => {
        ctx.setPositionProvider(() => {
          throw new Error("camera gone");
        });
        ctx.emit({ type: "graphics_diagnostic", severity: "fatal", category: "device-lost" });
      },
    };
    const client = new UptimizrClient(errorConfig(m.transport)).use(collector);
    client.start();
    await client.flush();

    const diag = m.batches.flatMap((b) => b.events).find((e) => e.type === "graphics_diagnostic")!;
    expect(diag).toBeDefined();
    expect((diag as { position?: number[] }).position).toBeUndefined();
  });
});

describe("flush delivery under failure (#402)", () => {
  /** A transport whose sends stay pending until the test settles them. */
  function deferredTransport() {
    const calls: Array<{ batch: CollectRequest; settle: (ok: boolean) => void }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const transport: Transport = {
      send: (batch) =>
        new Promise<boolean>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          calls.push({
            batch,
            settle: (ok) => {
              inFlight -= 1;
              resolve(ok);
            },
          });
        }),
    };
    return { transport, calls, maxInFlight: () => maxInFlight };
  }

  /** Readable label per event: the custom name, or the event type. */
  const label = (e: CollectRequest["events"][number]) =>
    e.type === "custom" ? (e as { name: string }).name : e.type;

  /** Stub `navigator.sendBeacon` with Chromium's 64 KiB keepalive quota. */
  function stubBeacon(quota = 64 * 1024) {
    const accepted: Blob[] = [];
    const refused: number[] = [];
    vi.stubGlobal("navigator", {
      sendBeacon: (_url: string, data: Blob) => {
        if (data.size > quota) {
          refused.push(data.size);
          return false;
        }
        accepted.push(data);
        return true;
      },
    });
    return { accepted, refused };
  }

  const parseBlobs = (blobs: Blob[]) =>
    Promise.all(blobs.map(async (b) => JSON.parse(await b.text()) as CollectRequest));

  /** A ~4.3 KB `runtime_error`, the shape the issue's repro uses. */
  const bigError = (i: number): EventInput => ({
    type: "runtime_error",
    kind: "error",
    message: `boom ${i}`,
    stack: "x".repeat(4096),
  });

  const message = (e: CollectRequest["events"][number]) =>
    e.type === "runtime_error" ? e.message : e.type;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps at most one flush in flight; concurrent calls coalesce", async () => {
    const d = deferredTransport();
    const client = new UptimizrClient(baseConfig(d.transport));
    client.start();

    const first = client.flush();
    client.track("a");
    client.track("b");
    const second = client.flush();
    const third = client.flush();
    expect(d.calls).toHaveLength(1);

    d.calls[0]!.settle(true);
    await vi.waitFor(() => expect(d.calls).toHaveLength(2));
    d.calls[1]!.settle(true);
    await Promise.all([first, second, third]);

    expect(d.maxInFlight()).toBe(1);
    // Every event sent exactly once, in emit order.
    expect(d.calls.flatMap((c) => c.batch.events.map(label))).toEqual(["session_start", "a", "b"]);
  });

  it("does not start a second flush from emit while one is in flight", async () => {
    const d = deferredTransport();
    const client = new UptimizrClient({ ...baseConfig(d.transport), batchSize: 2 });
    client.start();
    client.track("a"); // reaches batchSize -> flush starts
    for (let i = 0; i < 5; i++) client.track(`e${i}`);
    expect(d.calls).toHaveLength(1);

    // When the in-flight send lands, the events queued meanwhile go in the next
    // paced flush, a second after the first one started.
    d.calls[0]!.settle(true);
    await vi.waitFor(() => expect(d.calls).toHaveLength(2), { timeout: 2_000 });
    d.calls[1]!.settle(true);
    await client.flush();
    expect(d.maxInFlight()).toBe(1);
    expect(d.calls.flatMap((c) => c.batch.events.map(label))).toEqual([
      "session_start",
      "a",
      "e0",
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
  });

  it("paces the batch-size trigger to one flush a second, whatever the event rate", async () => {
    vi.useFakeTimers();
    const m = mockTransport();
    const client = new UptimizrClient({ ...baseConfig(m.transport), batchSize: 20 });
    client.start();
    // An animated character: 200 node samples a second for 3 s, one every 5 ms.
    for (let i = 0; i < 600; i++) {
      client.track(`n${i}`);
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    // Unpaced, this was a request per emit once the batch filled. Paced, it is
    // about one a second, and every event still arrives, in order.
    expect(m.batches.length).toBeLessThanOrEqual(5);
    const sent = m.batches.flatMap((b) => b.events.map(label));
    expect(sent).toEqual(["session_start", ...Array.from({ length: 600 }, (_, i) => `n${i}`)]);
    await client.stop();
  });

  it("does not retry a failed flush on every later emit", async () => {
    vi.useFakeTimers();
    const m = mockTransport();
    m.setOk(false);
    const client = new UptimizrClient({ ...baseConfig(m.transport), batchSize: 2 });
    client.start();
    client.track("first"); // reaches batchSize -> flush -> fails
    await vi.advanceTimersByTimeAsync(0);
    expect(m.batches).toHaveLength(1);

    // One event per frame, each after the previous attempt has re-queued.
    for (let i = 0; i < 10; i++) {
      client.track(`e${i}`);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(m.batches).toHaveLength(1);
  });

  it("retries a failed flush on an exponential backoff, then resumes normal flushing", async () => {
    vi.useFakeTimers();
    const m = mockTransport();
    m.setOk(false);
    const client = new UptimizrClient({ ...baseConfig(m.transport), batchSize: 2 });
    client.start();
    client.track("first"); // flush #1 fails at t=0
    await vi.advanceTimersByTimeAsync(0);
    expect(m.batches).toHaveLength(1);

    // First retry after 1s, then 2s, then 4s.
    await vi.advanceTimersByTimeAsync(999);
    expect(m.batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.batches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(m.batches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.batches).toHaveLength(3);

    client.track("during-outage");
    m.setOk(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(m.batches).toHaveLength(4);
    // The recovered send carries the whole backlog, still in order.
    expect(m.batches[3]!.events.map(label)).toEqual(["session_start", "first", "during-outage"]);

    // Healthy again: the batch-size trigger fires on emit with no delay.
    client.track("x");
    client.track("y");
    await vi.advanceTimersByTimeAsync(0);
    expect(m.batches).toHaveLength(5);
    expect(m.batches[4]!.events.map(label)).toEqual(["x", "y"]);
  });

  it("does not let the interval timer defeat the backoff", async () => {
    vi.useFakeTimers();
    const m = mockTransport();
    m.setOk(false);
    const client = new UptimizrClient({ ...baseConfig(m.transport), flushIntervalMs: 100 });
    client.start();
    await vi.advanceTimersByTimeAsync(100); // timer flush fails at t=100
    expect(m.batches).toHaveLength(1);
    // Backoff of 1s: the 100ms timer ticks in between must not send.
    await vi.advanceTimersByTimeAsync(900);
    expect(m.batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(m.batches).toHaveLength(2);
    await client.stop();
  });

  it("caps the backoff delay at 60s", async () => {
    vi.useFakeTimers();
    const m = mockTransport();
    m.setOk(false);
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    await client.flush();
    // 1+2+4+8+16+32 = 63s for six retries, then one every 60s.
    await vi.advanceTimersByTimeAsync(63_000);
    expect(m.batches).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(m.batches).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.batches).toHaveLength(8);
    await client.stop();
  });

  it("an explicit flush() still attempts immediately while backing off", async () => {
    vi.useFakeTimers();
    const m = mockTransport();
    m.setOk(false);
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    await client.flush();
    expect(m.batches).toHaveLength(1);
    m.setOk(true);
    await client.flush();
    expect(m.batches).toHaveLength(2);
    // Success cancels the pending retry: nothing more is sent.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.batches).toHaveLength(2);
  });

  it("stops retrying once the client is stopped", async () => {
    vi.useFakeTimers();
    const m = mockTransport();
    m.setOk(false);
    const client = new UptimizrClient(baseConfig(m.transport));
    client.start();
    await client.flush(); // fails -> retry scheduled
    await client.stop(); // unload flush also fails
    const after = m.batches.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(m.batches).toHaveLength(after);
  });

  it("splits a backlog into chunks under the beacon quota so it can drain", async () => {
    const beacon = stubBeacon();
    const client = new UptimizrClient({
      projectId: "proj_demo",
      endpoint: "https://collect.test",
      flushIntervalMs: 0,
      batchSize: 1000,
    });
    client.start();
    for (let i = 0; i < 20; i++) client.emit(bigError(i)); // ~90 KB serialized
    await client.flush();

    expect(beacon.refused).toEqual([]);
    expect(beacon.accepted.length).toBeGreaterThan(1);
    for (const blob of beacon.accepted) expect(blob.size).toBeLessThanOrEqual(60_000);
    const bodies = await parseBlobs(beacon.accepted);
    // Every event delivered exactly once, in emit order.
    expect(bodies.flatMap((b) => b.events).map(message)).toEqual([
      "session_start",
      ...Array.from({ length: 20 }, (_, i) => `boom ${i}`),
    ]);
    for (const b of bodies) expect(b.events.length).toBeLessThanOrEqual(LIMITS.maxBatchEvents);
  });

  it("re-queues only the chunk that failed, keeping event order", async () => {
    const sent: CollectRequest[] = [];
    let failNext = false;
    const transport: Transport = {
      send: async (batch) => {
        if (failNext) {
          failNext = false;
          return false;
        }
        sent.push(batch);
        return true;
      },
    };
    const client = new UptimizrClient(baseConfig(transport));
    client.start();
    for (let i = 0; i < 20; i++) client.emit(bigError(i));
    await client.flush(); // drains in several chunks
    expect(sent.length).toBeGreaterThan(1);

    sent.length = 0;
    for (let i = 20; i < 40; i++) client.emit(bigError(i));
    failNext = true; // the first chunk of the next drain fails
    await client.flush();
    expect(sent).toHaveLength(0); // the drain stops at the first failure
    await client.flush();
    expect(sent.flatMap((b) => b.events).map(message)).toEqual(
      Array.from({ length: 20 }, (_, i) => `boom ${i + 20}`),
    );
    await client.stop();
  });

  it("hands every chunk to sendBeacon inside the pagehide handler, ignoring the backoff", async () => {
    vi.useFakeTimers();
    const win = installFakeWindow();
    try {
      let beaconOk = false;
      const accepted: Blob[] = [];
      vi.stubGlobal("navigator", {
        sendBeacon: (_url: string, data: Blob) => {
          if (!beaconOk || data.size > 64 * 1024) return false;
          accepted.push(data);
          return true;
        },
      });
      const client = new UptimizrClient({
        projectId: "proj_demo",
        endpoint: "https://collect.test",
        flushIntervalMs: 0,
        batchSize: 1000,
      });
      client.start();
      for (let i = 0; i < 20; i++) client.emit(bigError(i));
      await client.flush(); // collector unreachable -> backing off
      beaconOk = true;

      win.fire("pagehide");
      // Synchronously, before any timer or task: the whole queue reached sendBeacon.
      expect(accepted.length).toBeGreaterThan(1);
      const types = (await parseBlobs(accepted)).flatMap((b) => b.events.map((e) => e.type));
      expect(types[0]).toBe("session_start");
      expect(types.at(-1)).toBe("session_end");
      expect(types.filter((t) => t === "runtime_error")).toHaveLength(20);
    } finally {
      win.restore();
    }
  });

  it("flushes on visibilitychange: hidden while backing off", async () => {
    vi.useFakeTimers();
    const win = installFakeWindow();
    try {
      const m = mockTransport();
      m.setOk(false);
      const client = new UptimizrClient(baseConfig(m.transport));
      client.start();
      await client.flush(); // fails -> backing off
      const before = m.batches.length;
      m.setOk(true);
      win.doc.visibilityState = "hidden";
      win.fire("visibilitychange");
      expect(m.batches).toHaveLength(before + 1);
      expect(m.batches.at(-1)!.events.map((e) => e.type)).toEqual([
        "session_start",
        "viewport_resize",
        "visibility_change",
      ]);
      await client.stop();
    } finally {
      win.restore();
    }
  });

  it("does not wait for an in-flight flush before the unload flush", async () => {
    const d = deferredTransport();
    const client = new UptimizrClient(baseConfig(d.transport));
    client.start();
    void client.flush(); // session_start in flight, not settled yet
    client.track("late");
    const stopped = client.stop("hidden");
    // The unload send went out while the steady-state one is still pending.
    expect(d.calls).toHaveLength(2);
    expect(d.calls[1]!.batch.events.map(label)).toEqual(["late", "session_end"]);
    d.calls[0]!.settle(true);
    d.calls[1]!.settle(true);
    await stopped;
  });
});
