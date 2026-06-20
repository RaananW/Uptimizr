import { describe, it, expect, vi } from "vitest";
import { anyEventSchema, type CollectRequest } from "@uptimizr/schema";
import { UptimizrClient } from "../client.js";
import type { Collector, Transport } from "../types.js";

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

describe("UptimizrClient lifecycle capture", () => {
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
