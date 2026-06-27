import { SCHEMA_VERSION, DEFAULT_SCENE_ID, sceneIdSchema } from "@uptimizr/schema";
import type { AnyEvent, CollectRequest, CustomPropValue } from "@uptimizr/schema";

import { EventQueue } from "./queue.js";
import { randomId } from "./idgen.js";
import { createBeaconTransport } from "./transport.js";
import {
  createMainProcessor,
  createWorkerProcessor,
  type Processor,
  type WorkerFactory,
} from "./processor.js";
import { createAggregator, type AggregatorConfig } from "./aggregation/aggregator.js";
import type { Snapshot } from "./aggregation/snapshot.js";
import {
  createMainSink,
  createWorkerAggregationSink,
  type AggregationSink,
} from "./aggregationSink.js";
import { SDK_VERSION } from "./version.js";
import type {
  CapabilityChangeReport,
  Collector,
  CollectorContext,
  CollectorHandle,
  EventInput,
  ResolvedConfig,
  StartMeta,
  TrackInputOptions,
  Transport,
  UptimizrConfig,
} from "./types.js";

const DEFAULTS = {
  batchSize: 20,
  flushIntervalMs: 5000,
  maxQueueSize: 1000,
  resizeDebounceMs: 250,
} as const;

function resolveConfig(config: UptimizrConfig): ResolvedConfig {
  return {
    projectId: config.projectId,
    endpoint: config.endpoint,
    sdkVersion: config.sdkVersion ?? SDK_VERSION,
    batchSize: config.batchSize ?? DEFAULTS.batchSize,
    flushIntervalMs: config.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
    maxQueueSize: config.maxQueueSize ?? DEFAULTS.maxQueueSize,
    offload: config.offload ?? "main",
    disabled: config.disabled ?? false,
    captureLifecycle: config.captureLifecycle ?? true,
    resizeDebounceMs: config.resizeDebounceMs ?? DEFAULTS.resizeDebounceMs,
    captureErrors: config.captureErrors ?? false,
    debug: config.debug ?? false,
  };
}

/**
 * The core Uptimizr client. Framework-agnostic: it owns the session, the event
 * queue, batching/flush scheduling, and transport. Engine-specific capture is added
 * via `use(collector)` (e.g. the Babylon adapter), keeping this package free of any
 * 3D-engine dependency.
 *
 * Privacy: no cookies, no persistent client ID. The `sessionId` is in-memory only
 * and the server assigns the cookieless `visitorId` during ingestion (ADR 0003).
 */
export class UptimizrClient {
  readonly config: ResolvedConfig;
  readonly sessionId: string;

  private readonly queue: EventQueue;
  private readonly transport: Transport;
  private readonly processor: Processor;
  private readonly beforeSend?: (event: AnyEvent) => AnyEvent | null;
  private readonly collectors: Collector[] = [];
  private readonly handles: CollectorHandle[] = [];
  private readonly aggSinks: AggregationSink[] = [];
  /** Set when a custom transport disables worker offload (main-thread closure). */
  private readonly customTransport?: Transport;
  /** Bundler escape hatch for constructing the offload worker. */
  private readonly createWorkerFn?: () => Worker;

  private started = false;
  private startedAt = 0;
  private url?: string;
  private currentScene: string = DEFAULT_SCENE_ID;
  private pageMeta?: AnyEvent["pageMeta"];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private errorCount = 0;
  private lastErrorKey: string | undefined;
  private readonly boundVisibility = () => this.onVisibilityChange();
  private readonly boundPageHide = () => {
    void this.stop("hidden");
  };
  private readonly boundFocus = () => this.onFocusChange(true);
  private readonly boundBlur = () => this.onFocusChange(false);
  private readonly boundResize = () => this.onResize();
  private readonly boundError = (event: ErrorEvent) => this.onErrorEvent(event);
  private readonly boundRejection = (event: PromiseRejectionEvent) =>
    this.onUnhandledRejection(event);

  constructor(config: UptimizrConfig) {
    this.config = resolveConfig(config);
    this.sessionId = randomId();
    this.queue = new EventQueue(this.config.maxQueueSize);
    this.transport = config.transport ?? createBeaconTransport(this.config.endpoint);
    this.customTransport = config.transport;
    this.createWorkerFn = config.createWorker;
    this.processor = this.createProcessor(config);
    this.beforeSend = config.beforeSend;
  }

  /** Register a capture plugin. Call before `start` (or after; it starts immediately). */
  use(collector: Collector): this {
    this.collectors.push(collector);
    if (this.started) {
      this.startCollector(collector);
    }
    return this;
  }

  /** Begin the session: emit `session_start`, schedule flushing, and start collectors. */
  start(meta: StartMeta = {}): void {
    if (this.started || this.config.disabled) {
      return;
    }
    this.started = true;
    this.startedAt = this.now();
    this.url = meta.url ?? this.defaultUrl();
    this.pageMeta = meta.pageMeta;

    // Apply the initial scene (if any) before session_start so it is stamped.
    if (meta.sceneId != null) {
      const parsed = sceneIdSchema.safeParse(meta.sceneId);
      if (parsed.success) {
        this.currentScene = parsed.data;
      } else {
        this.log(`ignoring invalid initial sceneId: ${String(meta.sceneId)}`);
      }
    }

    this.emit({
      type: "session_start",
      ...(meta.device ? { device: meta.device } : {}),
      ...(meta.graphics ? { graphics: meta.graphics } : {}),
      ...(meta.scene ? { scene: meta.scene } : {}),
      ...(meta.connector ? { connector: meta.connector } : {}),
      ...(meta.user ? { user: meta.user } : {}),
    });

    if (this.config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
    }
    this.bindLifecycle();

    for (const collector of this.collectors) {
      this.startCollector(collector);
    }
  }

  /**
   * Switch the active scene/area (ADR 0010). Stamps the new `sceneId` on every
   * subsequent event and emits an ordered `scene_change` marker so the replay
   * timeline records the transition. Invalid ids are ignored (logged in debug).
   * No-ops if the scene is unchanged. May be called before `start`, in which case
   * the scene is applied to `session_start`.
   */
  setScene(sceneId: string): void {
    if (this.config.disabled) {
      return;
    }
    const parsed = sceneIdSchema.safeParse(sceneId);
    if (!parsed.success) {
      this.log(`ignoring invalid sceneId: ${String(sceneId)}`);
      return;
    }
    if (parsed.data === this.currentScene) {
      return;
    }
    this.currentScene = parsed.data;
    if (this.started) {
      this.emit({ type: "scene_change" } as EventInput);
    }
  }

  /** Build the envelope and queue an event. */
  emit(input: EventInput): void {
    if (!this.started || this.config.disabled) {
      return;
    }
    this.emitInternal(input, this.now());
  }

  /**
   * Build the envelope (stamping the given `ts`) and queue an event. Unlike the
   * public {@link emit}, this does **not** gate on `started`, so finalized events
   * returned asynchronously from the worker-resident aggregator are still queued
   * while the session is draining on stop (replay-completeness, ADR 0031 §5). The
   * `ts` is the snapshot's page-stamped capture time, so worker round-trip latency
   * does not skew timestamps.
   */
  private emitInternal(input: EventInput, ts: number): void {
    if (this.config.disabled) {
      return;
    }
    const event = {
      ...input,
      projectId: this.config.projectId,
      sessionId: this.sessionId,
      ts,
      sdkVersion: this.config.sdkVersion,
      ...(this.url ? { url: this.url } : {}),
      ...(this.currentScene !== DEFAULT_SCENE_ID ? { sceneId: this.currentScene } : {}),
      ...(this.pageMeta ? { pageMeta: this.pageMeta } : {}),
    } as AnyEvent;

    const finalEvent = this.beforeSend ? this.beforeSend(event) : event;
    if (!finalEvent) {
      return;
    }

    this.queue.enqueue(finalEvent);
    if (this.queue.size >= this.config.batchSize) {
      void this.flush();
    }
  }

  /** Emit a developer-defined `custom` event. */
  track(name: string, props?: Record<string, CustomPropValue>): void {
    this.emit({ type: "custom", name, ...(props ? { props } : {}) } as EventInput);
  }

  /**
   * Emit an `input_action` for a discrete, non-pointer input — a keyboard
   * key/chord or a gamepad button bound to an app action (ADR 0023). This is the
   * engine-neutral path: the host app reports the *semantic* action it mapped the
   * input to. Pointer/ray inputs flow through the connector's `pointer_*` /
   * `mesh_interaction` capture instead; continuous navigation stays in
   * `camera_sample`.
   *
   * Privacy (ADR 0003): pass app-defined action labels only — never raw typed
   * text. `source` defaults to `"keyboard"` since that is the most common caller.
   */
  trackInput(action: string, opts: TrackInputOptions = {}): void {
    if (!action) {
      return;
    }
    this.emit({
      type: "input_action",
      action,
      source: opts.source ?? "keyboard",
      ...(opts.code ? { code: opts.code } : {}),
      ...(typeof opts.button === "number" ? { button: opts.button } : {}),
      ...(typeof opts.pressed === "boolean" ? { pressed: opts.pressed } : {}),
      ...(opts.handedness ? { handedness: opts.handedness } : {}),
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    } as EventInput);
  }

  /**
   * Report a capability / fidelity transition — a fallback or recovery (#49,
   * design §E). Engines decide their backend at init and rarely expose a runtime
   * "I downgraded" hook, so this is the engine-neutral, **app-reported** path: the
   * host app describes the transition it performed (e.g. a WebGPU→WebGL2
   * downgrade, a quality/LOD auto-downgrade, or a re-init after a lost device).
   * This pairs with the raw `context_lost` / `context_restored` lifecycle events.
   *
   * Privacy (ADR 0003): pass low-cardinality, app-defined tokens only — never raw
   * device strings or PII.
   */
  reportCapabilityChange(change: CapabilityChangeReport): void {
    if (!change.kind) {
      return;
    }
    this.emit({
      type: "capability_change",
      kind: change.kind,
      ...(change.from ? { from: change.from } : {}),
      ...(change.to ? { to: change.to } : {}),
      ...(change.reason ? { reason: change.reason } : {}),
    } as EventInput);
  }

  /** Send all queued events. On failure, events are re-queued for the next attempt. */
  async flush(opts?: { unload?: boolean }): Promise<void> {
    const events = this.queue.drain();
    if (events.length === 0) {
      return;
    }
    const batch: CollectRequest = { schemaVersion: SCHEMA_VERSION, events };
    // Steady-state batches may be offloaded to a worker; the terminal unload
    // flush always runs on the main thread for delivery reliability (ADR 0031).
    const ok = await (opts?.unload
      ? this.processor.processUnload(batch)
      : this.processor.process(batch));
    if (!ok) {
      this.queue.prepend(events);
      this.log("flush failed; re-queued", events.length);
    }
  }

  /** End the session: emit `session_end`, flush, and tear down collectors/timers. */
  async stop(reason: "manual" | "hidden" | "unload" | "timeout" = "manual"): Promise<void> {
    if (!this.started) {
      return;
    }
    this.emit({
      type: "session_end",
      durationMs: this.now() - this.startedAt,
      reason,
    } as EventInput);

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.unbindLifecycle();
    for (const handle of this.handles.splice(0)) {
      handle.stop();
    }
    // Drain any worker-resident aggregator state so the final windows are
    // finalized and their events queued on the main thread before we send
    // (ADR 0031 §5). `postMessage` ordering guarantees every prior snapshot's
    // events arrive before each sink's drain barrier resolves. `started` is still
    // true here so those returned events queue normally.
    if (this.aggSinks.length > 0) {
      await Promise.all(this.aggSinks.map((sink) => sink.drain()));
    }

    this.started = false;
    // Terminal flush on the main thread (beacon-reliable), then release the
    // worker(s) if any were running (ADR 0031).
    await this.flush({ unload: true });
    for (const sink of this.aggSinks.splice(0)) {
      sink.dispose();
    }
    this.processor.dispose();
  }

  /** Current time in epoch ms. Isolated for test overrides. */
  now(): number {
    return Date.now();
  }

  /**
   * Choose the processor (ADR 0031). Defaults to the main-thread processor.
   * `offload: "worker"` opts into a worker for steady-state serialization +
   * dispatch, but only when no custom transport is set (a custom transport is a
   * main-thread closure the worker cannot run) and a worker can actually be
   * constructed; otherwise it transparently falls back to the main thread.
   */
  private createProcessor(config: UptimizrConfig): Processor {
    if (this.config.offload === "worker") {
      if (config.transport) {
        this.log("custom transport set; worker offload disabled (transport runs on main thread)");
      } else {
        const worker = createWorkerProcessor({
          endpoint: this.config.endpoint,
          unloadTransport: this.transport,
          ...(config.createWorker
            ? { workerFactory: config.createWorker as unknown as WorkerFactory }
            : {}),
        });
        if (worker) {
          return worker;
        }
        this.log("worker offload unavailable; falling back to main-thread processor");
      }
    }
    return createMainProcessor(this.transport);
  }

  /**
   * Build the aggregation sink for a connector channel (ADR 0031 follow-up, #10),
   * mirroring {@link createProcessor}. With `offload: "worker"` (and no custom
   * transport) snapshots are aggregated in a worker; otherwise — or if a worker
   * cannot be constructed — a synchronous main-thread aggregator runs, keeping the
   * default path byte-for-byte identical to inline-connector aggregation.
   */
  private createAggregation(config: AggregatorConfig): (snapshot: Snapshot) => void {
    if (this.config.offload === "worker" && !this.customTransport) {
      const sink = createWorkerAggregationSink({
        config,
        onEvents: (events, capturedAt) => {
          for (const event of events) {
            this.emitInternal(event, capturedAt);
          }
        },
        ...(this.createWorkerFn
          ? { workerFactory: this.createWorkerFn as unknown as WorkerFactory }
          : {}),
      });
      if (sink) {
        this.aggSinks.push(sink);
        return (snapshot) => sink.ingest(snapshot, this.now());
      }
      this.log("worker aggregation unavailable; falling back to main-thread aggregator");
    }
    const aggregator = createAggregator({ ...config, emit: (event) => this.emit(event) });
    const sink = createMainSink(aggregator);
    this.aggSinks.push(sink);
    return (snapshot) => sink.ingest(snapshot, this.now());
  }

  private startCollector(collector: Collector): void {
    const ctx: CollectorContext = {
      config: this.config,
      sessionId: this.sessionId,
      emit: (event) => this.emit(event),
      track: (name, props) => this.track(name, props),
      trackInput: (action, opts) => this.trackInput(action, opts),
      reportCapabilityChange: (change) => this.reportCapabilityChange(change),
      setScene: (sceneId) => this.setScene(sceneId),
      createAggregation: (config) => this.createAggregation(config),
      now: () => this.now(),
    };
    try {
      const handle = collector.start(ctx);
      if (handle) {
        this.handles.push(handle);
      }
    } catch (err) {
      this.log(`collector "${collector.name}" failed to start`, err);
    }
  }

  private onVisibilityChange(): void {
    const doc = (globalThis as { document?: Document }).document;
    const hidden = doc?.visibilityState === "hidden";
    if (this.config.captureLifecycle && doc) {
      this.emit({ type: "visibility_change", state: hidden ? "hidden" : "visible" } as EventInput);
    }
    if (hidden) {
      void this.flush({ unload: true });
    }
  }

  private onFocusChange(focused: boolean): void {
    if (this.config.captureLifecycle) {
      this.emit({ type: "focus_change", focused } as EventInput);
    }
  }

  private onResize(): void {
    if (!this.config.captureLifecycle) {
      return;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
    }
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.emitViewportResize();
    }, this.config.resizeDebounceMs);
  }

  /** Emit a `viewport_resize` from the current window dimensions, if available. */
  private emitViewportResize(): void {
    const g = globalThis as {
      innerWidth?: number;
      innerHeight?: number;
      devicePixelRatio?: number;
    };
    if (typeof g.innerWidth !== "number" || typeof g.innerHeight !== "number") {
      return;
    }
    if (g.innerWidth <= 0 || g.innerHeight <= 0) {
      return;
    }
    this.emit({
      type: "viewport_resize",
      width: g.innerWidth,
      height: g.innerHeight,
      ...(typeof g.devicePixelRatio === "number" ? { dpr: g.devicePixelRatio } : {}),
    } as EventInput);
  }

  /** Max `runtime_error` events emitted per session (ADR 0013 storm control). */
  private static readonly MAX_ERRORS_PER_SESSION = 50;

  private onErrorEvent(event: ErrorEvent): void {
    this.emitError({
      kind: "error",
      message: event.message || "Unknown error",
      ...(event.filename ? { source: event.filename } : {}),
      ...(typeof event.lineno === "number" ? { lineno: event.lineno } : {}),
      ...(typeof event.colno === "number" ? { colno: event.colno } : {}),
      ...(event.error instanceof Error && event.error.stack ? { stack: event.error.stack } : {}),
    });
  }

  private onUnhandledRejection(event: PromiseRejectionEvent): void {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "Unhandled promise rejection";
    this.emitError({
      kind: "unhandledrejection",
      message: message || "Unhandled promise rejection",
      ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}),
    });
  }

  /**
   * Emit a `runtime_error`, applying ADR 0013 storm control: drop a consecutive
   * duplicate (same message+stack) and cap the total per session. Free-text
   * fields are length-bounded to match the schema; deeper redaction is the
   * deployer's job via `beforeSend`.
   */
  private emitError(input: {
    kind: "error" | "unhandledrejection";
    message: string;
    source?: string;
    lineno?: number;
    colno?: number;
    stack?: string;
  }): void {
    if (this.errorCount >= UptimizrClient.MAX_ERRORS_PER_SESSION) return;
    const key = `${input.message}\u0000${input.stack ?? ""}`;
    if (key === this.lastErrorKey) return;
    this.lastErrorKey = key;
    this.errorCount += 1;
    this.emit({
      type: "runtime_error",
      kind: input.kind,
      message: input.message.slice(0, 1024),
      ...(input.source ? { source: input.source.slice(0, 1024) } : {}),
      ...(typeof input.lineno === "number" ? { lineno: input.lineno } : {}),
      ...(typeof input.colno === "number" ? { colno: input.colno } : {}),
      ...(input.stack ? { stack: input.stack.slice(0, 4096) } : {}),
    } as EventInput);
  }

  private bindLifecycle(): void {
    const doc = (globalThis as { document?: Document }).document;
    const win = (globalThis as { addEventListener?: Window["addEventListener"] }).addEventListener
      ? (globalThis as unknown as Window)
      : undefined;
    doc?.addEventListener("visibilitychange", this.boundVisibility);
    win?.addEventListener("pagehide", this.boundPageHide);
    if (this.config.captureLifecycle && win) {
      win.addEventListener("focus", this.boundFocus);
      win.addEventListener("blur", this.boundBlur);
      win.addEventListener("resize", this.boundResize);
      // Emit an initial viewport sample so every session has a known starting
      // viewport for heatmap normalization.
      this.emitViewportResize();
    }
    if (this.config.captureErrors && win) {
      win.addEventListener("error", this.boundError);
      win.addEventListener("unhandledrejection", this.boundRejection);
    }
  }

  private unbindLifecycle(): void {
    const doc = (globalThis as { document?: Document }).document;
    const win = (globalThis as { removeEventListener?: Window["removeEventListener"] })
      .removeEventListener
      ? (globalThis as unknown as Window)
      : undefined;
    doc?.removeEventListener("visibilitychange", this.boundVisibility);
    win?.removeEventListener("pagehide", this.boundPageHide);
    win?.removeEventListener("focus", this.boundFocus);
    win?.removeEventListener("blur", this.boundBlur);
    win?.removeEventListener("resize", this.boundResize);
    win?.removeEventListener("error", this.boundError);
    win?.removeEventListener("unhandledrejection", this.boundRejection);
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
    }
  }

  private defaultUrl(): string | undefined {
    const loc = (globalThis as { location?: Location }).location;
    return loc?.href;
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.debug("[uptimizr]", ...args);
    }
  }
}
