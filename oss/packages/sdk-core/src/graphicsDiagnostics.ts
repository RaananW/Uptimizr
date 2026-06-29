import { LIMITS } from "@uptimizr/schema";
import type { GraphicsApi } from "@uptimizr/schema";
import type { CollectorContext } from "./types.js";

/**
 * Structural view of a WebGPU `GPUDeviceLostInfo` (the value the `GPUDevice.lost`
 * promise resolves with). Declared locally — rather than depending on
 * `@webgpu/types` — so the helper stays dependency-free and tolerant of partial
 * shapes across browsers.
 *
 * @see https://www.w3.org/TR/webgpu/#gpudevicelostinfo
 */
export interface GpuDeviceLostInfoLike {
  /** `"destroyed"` for a requested loss (`device.destroy()`); otherwise unknown. */
  reason?: string;
  /** Human-readable detail (driver/agent text). Length-capped before emit. */
  message?: string;
}

/**
 * Structural view of the one field we read off a WebGPU `GPUDevice`: its `lost`
 * promise. We read structurally so connectors can keep their engine
 * (`@babylonjs/core`, `three`) a peer dependency and stay version-tolerant.
 */
export interface GpuDeviceLostLike {
  lost?: Promise<GpuDeviceLostInfoLike>;
}

/** Tuning for how long we wait for an async-initialized WebGPU device. */
export interface WireGpuDeviceLostOptions {
  /**
   * Max number of times to poll for the device before giving up. Defaults to 20
   * which, with the default {@link intervalMs}, spans ~5s — comfortably longer
   * than a WebGPU backend's async init while staying bounded (no leak).
   */
  maxAttempts?: number;
  /** Delay between device-acquisition attempts, in ms. Defaults to 250. */
  intervalMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_INTERVAL_MS = 250;

/**
 * Wire a WebGPU `GPUDevice.lost` into a `graphics_diagnostic` (ADR 0021 part 2,
 * `category: "device-lost"`). Engine-agnostic: every connector that can have a
 * WebGPU device hands a device *getter* here, so the gating, severity mapping,
 * length-cap, and event shape live in exactly one place.
 *
 * Behavior:
 * - **Opt-in gate.** No-ops (nothing scheduled, nothing emitted) unless
 *   `ctx.config.captureGraphicsDiagnostics` is on. (Unlike `context_lost`, which is
 *   always-on; device loss is the richer opt-in diagnostic.)
 * - **Async device init.** A WebGPU backend builds its device asynchronously
 *   (three's `renderer.init()` / first `renderAsync`, Babylon's `initAsync`), so
 *   the device is frequently `undefined` at collector `start()` time. We therefore
 *   take a *getter* and **poll** it (bounded by {@link WireGpuDeviceLostOptions})
 *   until the device appears, rather than reading once and silently giving up.
 * - **Severity.** `info` when `reason === "destroyed"` (an expected, app-requested
 *   loss via `device.destroy()`); `fatal` otherwise (an unrequested loss —
 *   rendering cannot continue).
 * - **Marker.** Emits a single discrete incident (no `count`): device loss is rare
 *   and decisive, so the high-fidelity marker is the right default here.
 * - **Privacy.** The optional `message` is locally truncated to
 *   {@link LIMITS.maxGraphicsDiagnosticMessageLength} and rides through `ctx.emit`,
 *   which applies the client's `beforeSend` for deployer-owned redaction.
 *
 * Teardown is cooperative: pass an `isActive` predicate (typically `() => !stopped`).
 * It is checked before each poll and again when `device.lost` resolves, so neither a
 * pending poll nor a late device loss emits after the collector has stopped.
 *
 * @param ctx Collector context (config + `emit`).
 * @param getDevice Returns the WebGPU device, or `undefined`/`null` while it is
 *   still initializing or on WebGL (where it never appears — a clean no-op). Must
 *   not throw; read the field defensively (optional chaining).
 * @param isActive Returns `false` once the collector has been torn down.
 * @param options Polling bounds (mainly for tests).
 */
export function wireGpuDeviceLost(
  ctx: CollectorContext,
  getDevice: () => GpuDeviceLostLike | undefined | null,
  isActive: () => boolean,
  options?: WireGpuDeviceLostOptions,
): void {
  if (!ctx.config.captureGraphicsDiagnostics) return;

  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  let attempts = 0;

  const attach = (device: GpuDeviceLostLike): void => {
    const lost = device.lost;
    if (!lost || typeof lost.then !== "function") return;
    void lost.then((info) => {
      if (!isActive()) return;
      const reason = typeof info?.reason === "string" ? info.reason : undefined;
      const severity = reason === "destroyed" ? "info" : "fatal";
      const rawMessage = typeof info?.message === "string" ? info.message : undefined;
      const message = rawMessage
        ? rawMessage.slice(0, LIMITS.maxGraphicsDiagnosticMessageLength)
        : undefined;

      ctx.emit({
        type: "graphics_diagnostic",
        severity,
        category: "device-lost",
        backend: "webgpu",
        ...(message ? { message } : {}),
      });
    });
  };

  const poll = (): void => {
    if (!isActive()) return;
    const device = getDevice();
    if (device) {
      attach(device);
      return;
    }
    // Device not ready yet (async backend init). Retry on a bounded schedule; the
    // WebGL path never produces a device, so this simply exhausts and stops.
    attempts += 1;
    if (attempts >= maxAttempts) return;
    setTimeout(poll, intervalMs);
  };

  poll();
}

/**
 * Shared **rate-limited rollup** for the noisy `graphics_diagnostic` signals
 * (ADR 0021 part 2 decision 4 / ADR 0012): a burst of incidents coalesces into one
 * `count`-bearing event instead of flooding ingestion. Tracks `count` plus the first
 * representative payload; `emit` composes the event from those. Used by both
 * `wireGpuUncapturedError` and `wireGlErrorSampling` so the aggregation logic lives once.
 */
export interface DiagnosticRollup<T> {
  /** Record one incident, capturing `first` on the very first record of a window. */
  record(first: T): void;
  /** Incidents accumulated in the current (un-flushed) window. */
  readonly count: number;
  /** Emit one aggregated event (if any) and reset the window. */
  flush(): void;
  /** Begin a bounded auto-flush interval. */
  start(intervalMs: number): void;
  /** Clear the interval and flush any remaining incidents. */
  stop(): void;
}

export function createDiagnosticRollup<T>(
  emit: (count: number, first: T | undefined) => void,
): DiagnosticRollup<T> {
  let count = 0;
  let first: T | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const flush = (): void => {
    if (count === 0) return;
    emit(count, first);
    count = 0;
    first = undefined;
  };
  return {
    record(value: T) {
      if (count === 0) first = value;
      count += 1;
    },
    get count() {
      return count;
    },
    flush,
    start(intervalMs: number) {
      timer = setInterval(flush, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      flush();
    },
  };
}

/**
 * Structural view of a WebGPU `GPUError` (the value carried on an
 * `uncapturederror` event). Declared locally so the helper stays dependency-free.
 * The subtype is detected by constructor name to avoid depending on `@webgpu/types`.
 *
 * @see https://www.w3.org/TR/webgpu/#gpuerror
 */
export interface GpuErrorLike {
  /** Human-readable detail. Length-capped before it rides on a rollup. */
  message?: string;
  /** Set on the concrete error class; used to detect out-of-memory vs validation. */
  constructor?: { name?: string };
}

/** Structural view of the one WebGPU `uncapturederror` event field we read. */
interface GpuUncapturedErrorEventLike {
  error?: GpuErrorLike;
}

/**
 * The subset of `EventTarget` we use on a WebGPU device. Declared structurally so
 * connectors keep their engine a peer dependency and stay version-tolerant.
 */
export interface GpuDeviceErrorTargetLike {
  addEventListener?: (
    type: "uncapturederror",
    listener: (e: GpuUncapturedErrorEventLike) => void,
  ) => void;
  removeEventListener?: (
    type: "uncapturederror",
    listener: (e: GpuUncapturedErrorEventLike) => void,
  ) => void;
}

/** Tuning for the rate-limited `uncapturederror` rollup. */
export interface WireGpuUncapturedErrorOptions extends WireGpuDeviceLostOptions {
  /**
   * How often, in ms, to flush an accumulated rollup mid-session. Defaults to
   * 30s. A flush also runs unconditionally at teardown. Set bursts coalesce into
   * one event per interval, so an error storm cannot flood ingestion.
   */
  flushIntervalMs?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

/**
 * Wire WebGPU `uncapturederror` into a **rate-limited per-session rollup**
 * (ADR 0021 part 2, decision 4 / ADR 0012). This is the highest-volume diagnostic,
 * so the default — and only — emission is aggregated: a burst of errors becomes a
 * single `graphics_diagnostic` carrying `count: N` plus the first message, never N
 * discrete events. Shared and engine-agnostic so every connector (Babylon, three,
 * …) hands a device *getter* here and the gating, subtype mapping, length-cap,
 * aggregation, and flush cadence live in exactly one place.
 *
 * Behavior:
 * - **Opt-in gate.** No-ops unless `ctx.config.captureGraphicsDiagnostics` is on.
 * - **Async device init.** Polls the getter (bounded, same as {@link wireGpuDeviceLost})
 *   until the WebGPU device appears, so a backend that builds its device async
 *   (three `renderer.init()`/`renderAsync`, Babylon `initAsync`) isn't missed.
 * - **Subtype.** `GPUOutOfMemoryError` → `out-of-memory` (`severity: error`);
 *   anything else → `validation` (`severity: warning`). The most severe category
 *   seen wins for the rollup; the first message is kept.
 * - **Rollup.** Accumulates `count` + first `message` and flushes one event on a
 *   bounded interval and again at teardown; emits nothing if no error occurred.
 * - **Privacy.** `message` is truncated to {@link LIMITS.maxGraphicsDiagnosticMessageLength}
 *   and rides through `ctx.emit` (so `beforeSend` applies); raw shader source is excluded.
 *
 * @returns A teardown function that removes the listener, clears the timer, and
 *   flushes any pending rollup. Connectors call it from `stop()`/dispose.
 * @param getDevice Returns the WebGPU device, or `undefined`/`null` while it is
 *   still initializing or on WebGL (a clean no-op). Must not throw.
 * @param isActive Returns `false` once the collector is torn down — nothing emits after.
 */
export function wireGpuUncapturedError(
  ctx: CollectorContext,
  getDevice: () => GpuDeviceErrorTargetLike | undefined | null,
  isActive: () => boolean,
  options?: WireGpuUncapturedErrorOptions,
): () => void {
  if (!ctx.config.captureGraphicsDiagnostics) return () => {};

  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const flushIntervalMs = options?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  let attempts = 0;

  let firstMessage: string | undefined;
  let category: "validation" | "out-of-memory" = "validation";
  let device: GpuDeviceErrorTargetLike | undefined;
  let listener: ((e: GpuUncapturedErrorEventLike) => void) | undefined;

  const rollup = createDiagnosticRollup<string | undefined>((n, first) => {
    const severity = category === "out-of-memory" ? "error" : "warning";
    ctx.emit({
      type: "graphics_diagnostic",
      severity,
      category,
      backend: "webgpu",
      count: n,
      ...(first ? { message: first } : {}),
    });
    category = "validation";
  });

  const attach = (target: GpuDeviceErrorTargetLike): void => {
    if (typeof target.addEventListener !== "function") return;
    device = target;
    listener = (e) => {
      if (!isActive()) return;
      const error = e?.error;
      if (rollup.count === 0) {
        const raw = typeof error?.message === "string" ? error.message : undefined;
        firstMessage = raw ? raw.slice(0, LIMITS.maxGraphicsDiagnosticMessageLength) : undefined;
      }
      rollup.record(firstMessage);
      if (error?.constructor?.name === "GPUOutOfMemoryError") category = "out-of-memory";
    };
    target.addEventListener("uncapturederror", listener);
    rollup.start(flushIntervalMs);
  };

  const poll = (): void => {
    if (!isActive()) return;
    const target = getDevice();
    if (target) {
      attach(target);
      return;
    }
    attempts += 1;
    if (attempts >= maxAttempts) return;
    setTimeout(poll, intervalMs);
  };

  poll();

  return () => {
    if (device && listener && typeof device.removeEventListener === "function") {
      device.removeEventListener("uncapturederror", listener);
    }
    rollup.stop();
  };
}
/* -------------------------------------------------------------------------- */
/* Shader compile/link failures (ADR 0021 part 2, `category: shader-compile`) */
/* -------------------------------------------------------------------------- */

/** Backends a shader/getError diagnostic can be tagged with. */
type ShaderBackend = "webgl" | "webgl2" | "webgpu";

/** Tuning for shader-compile capture (mainly for tests). */
export interface ShaderDiagnosticsOptions {
  /** Max shader-compile diagnostics emitted per session (storm guard). Default 25. */
  maxIncidents?: number;
}

const DEFAULT_MAX_SHADER_INCIDENTS = 25;

/**
 * Build a `graphics_diagnostic` for a shader compile/link **failure**. Pure and
 * redaction-aware: the engine info log is the message (length-capped); raw shader
 * `source` is appended **only** when the deployer opted in via `captureShaderSource`
 * (ADR 0021 part 2 — source is application IP). Either way the result is capped to
 * the schema limit and still rides through `beforeSend`.
 */
export function buildShaderCompileDiagnostic(input: {
  infoLog?: string;
  source?: string;
  backend?: ShaderBackend;
  captureShaderSource: boolean;
}): {
  type: "graphics_diagnostic";
  severity: "error";
  category: "shader-compile";
  backend?: ShaderBackend;
  message?: string;
} {
  const log = input.infoLog?.trim() ?? "";
  const includeSource = input.captureShaderSource && input.source ? input.source : "";
  const raw = includeSource ? `${log}\n${includeSource}`.trim() : log;
  const message = raw ? raw.slice(0, LIMITS.maxGraphicsDiagnosticMessageLength) : undefined;
  return {
    type: "graphics_diagnostic",
    severity: "error",
    category: "shader-compile",
    ...(input.backend ? { backend: input.backend } : {}),
    ...(message ? { message } : {}),
  };
}

/** Structural view of the WebGL context fields we read for shader diagnostics. */
export interface WebGlShaderContextLike {
  COMPILE_STATUS: number;
  LINK_STATUS: number;
  compileShader(shader: object): void;
  linkProgram(program: object): void;
  getShaderParameter(shader: object, pname: number): unknown;
  getProgramParameter(program: object, pname: number): unknown;
  getShaderInfoLog(shader: object): string | null;
  getProgramInfoLog(program: object): string | null;
  getShaderSource?(shader: object): string | null;
}

/**
 * Capture WebGL shader compile and program link **failures** as
 * `graphics_diagnostic` (`category: shader-compile`). Wraps the context's
 * `compileShader`/`linkProgram`; on a failed status it reads the matching info log
 * (and, when `captureShaderSource` is on, the shader source) and emits one capped,
 * redactable diagnostic. Bounded per session so a build loop cannot flood ingestion.
 *
 * Opt-in: no-ops unless `ctx.config.captureGraphicsDiagnostics`. Returns a detach
 * fn that restores the original methods.
 */
export function wireGlShaderDiagnostics(
  ctx: CollectorContext,
  gl: WebGlShaderContextLike,
  isActive: () => boolean,
  options?: ShaderDiagnosticsOptions,
): () => void {
  if (!ctx.config.captureGraphicsDiagnostics) return () => {};
  const max = options?.maxIncidents ?? DEFAULT_MAX_SHADER_INCIDENTS;
  const backend: ShaderBackend = gl.LINK_STATUS != null ? "webgl2" : "webgl";
  const wantSource = ctx.config.captureShaderSource;
  let count = 0;
  if (typeof gl.compileShader !== "function" || typeof gl.linkProgram !== "function")
    return () => {};
  const origCompile = gl.compileShader.bind(gl);
  const origLink = gl.linkProgram.bind(gl);

  const emit = (infoLog: string | null, source?: string): void => {
    if (!isActive() || count >= max) return;
    count += 1;
    ctx.emit(
      buildShaderCompileDiagnostic({
        backend,
        captureShaderSource: wantSource,
        ...(infoLog ? { infoLog } : {}),
        ...(source ? { source } : {}),
      }),
    );
  };

  gl.compileShader = function (shader: object) {
    origCompile(shader);
    if (!isActive()) return;
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const source = wantSource && gl.getShaderSource ? gl.getShaderSource(shader) : undefined;
      emit(gl.getShaderInfoLog(shader), source ?? undefined);
    }
  };
  gl.linkProgram = function (program: object) {
    origLink(program);
    if (!isActive()) return;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) emit(gl.getProgramInfoLog(program));
  };

  return () => {
    gl.compileShader = origCompile;
    gl.linkProgram = origLink;
  };
}

/** Structural view of the WebGPU device + module fields we read for shader info. */
export interface WebGpuShaderDeviceLike {
  createShaderModule(descriptor: { code?: string }): WebGpuShaderModuleLike;
}
interface WebGpuShaderModuleLike {
  getCompilationInfo?: () => Promise<{
    messages?: ReadonlyArray<{ type?: string; message?: string }>;
  }>;
  compilationInfo?: () => Promise<{
    messages?: ReadonlyArray<{ type?: string; message?: string }>;
  }>;
}

/**
 * Capture WebGPU shader-module compile errors as `graphics_diagnostic`
 * (`category: shader-compile`). Wraps `device.createShaderModule` and inspects the
 * module's async `compilationInfo()` for `error` messages. Source (`descriptor.code`)
 * is included only when `captureShaderSource` is on. Opt-in + bounded; returns detach.
 */
export function wireGpuShaderDiagnostics(
  ctx: CollectorContext,
  device: WebGpuShaderDeviceLike,
  isActive: () => boolean,
  options?: ShaderDiagnosticsOptions,
): () => void {
  if (!ctx.config.captureGraphicsDiagnostics) return () => {};
  const max = options?.maxIncidents ?? DEFAULT_MAX_SHADER_INCIDENTS;
  const wantSource = ctx.config.captureShaderSource;
  let count = 0;
  if (typeof device.createShaderModule !== "function") return () => {};
  const orig = device.createShaderModule.bind(device);

  device.createShaderModule = function (descriptor: { code?: string }) {
    const module = orig(descriptor);
    const info = module.getCompilationInfo ?? module.compilationInfo;
    if (typeof info === "function") {
      void info.call(module).then((result) => {
        if (!isActive() || count >= max) return;
        const errors = (result?.messages ?? []).filter((m) => m?.type === "error");
        if (errors.length === 0) return;
        count += 1;
        ctx.emit(
          buildShaderCompileDiagnostic({
            backend: "webgpu",
            captureShaderSource: wantSource,
            infoLog: errors.map((m) => m.message ?? "").join("\n"),
            ...(descriptor?.code ? { source: descriptor.code } : {}),
          }),
        );
      });
    }
    return module;
  };

  return () => {
    device.createShaderModule = orig;
  };
}

/* -------------------------------------------------------------------------- */
/* Sampled gl.getError() (ADR 0021 part 2, `category: validation`, WebGL only) */
/* -------------------------------------------------------------------------- */

/** Tuning for opportunistic `gl.getError()` sampling. */
export interface GlErrorSamplingOptions {
  /** Sampling interval in ms. Default 5000. NEVER per-frame (ADR forbids a sync stall). */
  intervalMs?: number;
}

const DEFAULT_GL_ERROR_INTERVAL_MS = 5000;
const GL_NO_ERROR = 0;

/** Structural view of the one method we poll: `gl.getError()`. */
export interface WebGlErrorContextLike {
  getError(): number;
}

/**
 * Opportunistically **sample** `gl.getError()` and emit a rate-limited rollup
 * `graphics_diagnostic` (`category: validation`, ADR 0021 part 2). Runs on a low-rate
 * timer — never per-frame, since `getError()` forces a sync GPU stall (ADR forbids it).
 * Non-`NO_ERROR` results are aggregated into a single `count`ed event flushed on the
 * next tick (and on teardown), so a storm cannot flood ingestion. WebGPU has no
 * `getError`, so passing nothing makes this a clean no-op.
 *
 * Opt-in: no-ops unless `captureGraphicsDiagnostics`. Returns a detach fn that flushes
 * any pending rollup and clears the timer.
 */
export function wireGlErrorSampling(
  ctx: CollectorContext,
  gl: WebGlErrorContextLike,
  isActive: () => boolean,
  options?: GlErrorSamplingOptions,
): () => void {
  if (!ctx.config.captureGraphicsDiagnostics) return () => {};
  const intervalMs = options?.intervalMs ?? DEFAULT_GL_ERROR_INTERVAL_MS;

  const rollup = createDiagnosticRollup<number>((n, first) => {
    ctx.emit({
      type: "graphics_diagnostic",
      severity: "warning",
      category: "validation",
      ...(first != null ? { code: `0x${first.toString(16)}` } : {}),
      count: n,
    });
  });

  const sample = (): void => {
    if (!isActive()) return;
    // Drain every pending GL error in one go: `getError()` reports one flag at a
    // time, so we loop until NO_ERROR to fold a tick's full backlog into the rollup.
    let code = gl.getError();
    while (code !== GL_NO_ERROR) {
      rollup.record(code);
      code = gl.getError();
    }
    rollup.flush();
  };

  const timer = setInterval(sample, intervalMs);
  return () => {
    clearInterval(timer);
    rollup.stop();
  };
}

/**
 * The result a connector's context-creation probe hands to
 * {@link wireContextCreationFailure}. Connectors read their engine/renderer
 * structurally (to keep the engine a peer dependency) and reduce it to this small,
 * engine-agnostic shape.
 */
export interface ContextCreationProbe {
  /**
   * `true` when the engine could not obtain a usable GL/WebGPU context or adapter
   * (e.g. `getContext()` / `requestAdapter()` returned null, or no backend is
   * usable). `false` for a healthy context — the common case, a clean no-op.
   */
  failed: boolean;
  /** The API that failed, when determinable; omit/`unknown` when it can't be told. */
  backend?: GraphicsApi;
  /** Optional engine/driver detail. Length-capped before emit. */
  message?: string;
}

/**
 * Emit a one-shot context-creation failure as a `graphics_diagnostic`
 * (ADR 0021 part 2, `category: "context-loss"`, `severity: "fatal"`) when a
 * connector cannot obtain a rendering context/adapter at init. Engine-agnostic:
 * every connector reduces its backend-specific check to a {@link ContextCreationProbe}
 * so the gating, length-cap, and event shape live in exactly one place.
 *
 * Behavior:
 * - **Opt-in gate.** No-ops unless `ctx.config.captureGraphicsDiagnostics` is on
 *   (mirroring {@link wireGpuDeviceLost}; `context_lost` runtime loss stays
 *   always-on, this *creation* case is the richer opt-in diagnostic).
 * - **Discrete marker.** Emits a single incident with no `count`: a creation
 *   failure is rare and decisive, so the high-fidelity marker is the right default.
 * - **Backend.** `unknown` when the connector can't determine which API failed
 *   (no context means little to introspect).
 * - **Ordering.** Connectors call this at `start()`. The client sets `started`
 *   before running collectors, so the marker queues right after `session_start`
 *   and is flushed by the normal cadence even though no transport round-trip has
 *   happened yet.
 * - **Privacy.** Any `message` is truncated to
 *   {@link LIMITS.maxGraphicsDiagnosticMessageLength} and rides `ctx.emit`, which
 *   applies the client's `beforeSend` for deployer-owned redaction.
 *
 * @param ctx Collector context (config + `emit`).
 * @param probe The connector's context-creation result. Must not throw; read the
 *   engine defensively (optional chaining) and pass `{ failed: false }` on doubt.
 */
export function wireContextCreationFailure(
  ctx: CollectorContext,
  probe: ContextCreationProbe,
): void {
  if (!ctx.config.captureGraphicsDiagnostics) return;
  if (!probe.failed) return;

  const message = probe.message
    ? probe.message.slice(0, LIMITS.maxGraphicsDiagnosticMessageLength)
    : undefined;

  ctx.emit({
    type: "graphics_diagnostic",
    severity: "fatal",
    category: "context-loss",
    backend: probe.backend ?? "unknown",
    ...(message ? { message } : {}),
  });
}
