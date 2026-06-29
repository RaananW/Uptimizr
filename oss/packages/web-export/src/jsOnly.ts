import type { CollectorContext } from "@uptimizr/sdk-core";
import { percentileAsc } from "@uptimizr/sdk-core";

/**
 * Minimal structural view of the engine's render `<canvas>` — the only DOM handle
 * the JS-only tier needs. Kept dependency-free so a web export can pass any
 * `EventTarget` (the real canvas, or a stub in tests).
 */
export interface CanvasView {
  addEventListener(type: string, handler: (e: unknown) => void): void;
  removeEventListener(type: string, handler: (e: unknown) => void): void;
  getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
}

/** A pointer event, read defensively (web exports vary across browsers). */
interface PointerEventView {
  clientX?: number;
  clientY?: number;
  button?: number;
}

/** Toggle the individual JS-only (zero-engine-code) capture channels. */
export interface JsOnlyCaptureOptions {
  /** Pointer-move screen heatmap. Default `true`. */
  pointerMove?: boolean;
  /** Click screen heatmap. Default `true`. */
  clicks?: boolean;
  /** Pointer down/up buttons. Default `false`. */
  buttons?: boolean;
  /** rAF FPS / `frame_perf`. Default `true`. */
  perf?: boolean;
  /** `window` error + unhandledrejection → `runtime_error`. Default `true`. */
  errors?: boolean;
}

export interface JsOnlyOptions {
  ctx: CollectorContext;
  /** The render canvas (or a resolver returning it once the export has booted). */
  canvas?: CanvasView | (() => CanvasView | null | undefined);
  capture?: JsOnlyCaptureOptions;
  /** Minimum gap between `pointer_move` samples, ms. Default `250`. */
  pointerMoveThrottleMs?: number;
  /** Performance reporting window, ms. Default `2000`. */
  perfWindowMs?: number;
  /** Frame-time (ms) above which a frame counts as a long frame. Default `50`. */
  jankFrameMs?: number;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Resolve the canvas from a value or lazy resolver. */
function resolveCanvas(
  canvas: JsOnlyOptions["canvas"],
): CanvasView | null {
  if (!canvas) return null;
  const c = typeof canvas === "function" ? canvas() : canvas;
  return c ?? null;
}

/**
 * The **JS-only, zero-engine-code capture tier** shared by every web-export
 * connector (ADR 0045 §3). It drives capture purely from the `<canvas>` DOM and
 * `requestAnimationFrame` — pointer move/click (screen-space) heatmaps, rAF
 * FPS/`frame_perf`, and `runtime_error` capture — without reading any engine
 * memory. This is the meaningful result a web export gets with **no** engine-side
 * bridge; pose / world-space / replay layer on once the bridge is added.
 *
 * Returns a teardown function that removes every listener and cancels the rAF loop.
 */
export function startJsOnlyCapture(options: JsOnlyOptions): () => void {
  const { ctx } = options;
  const capture = options.capture ?? {};
  const want = {
    pointerMove: capture.pointerMove ?? true,
    clicks: capture.clicks ?? true,
    buttons: capture.buttons ?? false,
    perf: capture.perf ?? true,
    errors: capture.errors ?? true,
  };
  const pointerThrottleMs = options.pointerMoveThrottleMs ?? 250;
  const perfWindowMs = options.perfWindowMs ?? 2000;
  const jankFrameMs = options.jankFrameMs ?? 50;

  let disposed = false;
  const teardowns: Array<() => void> = [];

  // --- Pointer / DOM listeners (screen-space only; no raycast — that's the bridge) ---
  const canvas = resolveCanvas(options.canvas);
  if (canvas && (want.pointerMove || want.clicks || want.buttons)) {
    const addListener = (type: string, handler: (e: unknown) => void) => {
      canvas.addEventListener(type, handler);
      teardowns.push(() => canvas.removeEventListener(type, handler));
    };

    const screenOf = (ev: PointerEventView): [number, number] => {
      const rect =
        typeof canvas.getBoundingClientRect === "function"
          ? canvas.getBoundingClientRect()
          : { left: 0, top: 0, width: 0, height: 0 };
      const w = rect.width || 1;
      const h = rect.height || 1;
      const x = typeof ev.clientX === "number" ? ev.clientX : rect.left;
      const y = typeof ev.clientY === "number" ? ev.clientY : rect.top;
      // Normalized, origin top-left, clamped to [0,1] — engine-independent.
      return [clamp01((x - rect.left) / w), clamp01((y - rect.top) / h)];
    };

    let lastPointerMove = 0;
    if (want.pointerMove) {
      addListener("pointermove", (raw) => {
        const now = ctx.now();
        if (now - lastPointerMove < pointerThrottleMs) return;
        lastPointerMove = now;
        ctx.emit({ type: "pointer_move", screen: screenOf(raw as PointerEventView) });
      });
    }

    if (want.buttons) {
      const emitButton = (type: "pointer_down" | "pointer_up") => (raw: unknown) => {
        const ev = raw as PointerEventView;
        ctx.emit({
          type,
          screen: screenOf(ev),
          ...(typeof ev.button === "number" ? { button: ev.button } : {}),
        });
      };
      addListener("pointerdown", emitButton("pointer_down"));
      addListener("pointerup", emitButton("pointer_up"));
    }

    if (want.clicks) {
      addListener("click", (raw) => {
        const ev = raw as PointerEventView;
        ctx.emit({
          type: "pointer_click",
          screen: screenOf(ev),
          ...(typeof ev.button === "number" ? { button: ev.button } : {}),
        });
      });
    }
  }

  // --- rAF performance (FPS / frame_perf), purely from requestAnimationFrame ---
  if (want.perf && typeof requestAnimationFrame === "function") {
    let frameTimes: number[] = [];
    let windowStart = ctx.now();
    let last = windowStart;
    const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : undefined;

    const flushPerf = (now: number) => {
      const elapsed = now - windowStart;
      if (elapsed <= 0 || frameTimes.length === 0) {
        windowStart = now;
        frameTimes = [];
        return;
      }
      const fps = (frameTimes.length / elapsed) * 1000;
      const sum = frameTimes.reduce((a, b) => a + b, 0);
      const frameTimeMs = sum / frameTimes.length;
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const longFrames = frameTimes.reduce((n, ft) => (ft > jankFrameMs ? n + 1 : n), 0);
      ctx.emit({
        type: "frame_perf",
        fps,
        frameTimeMs,
        frameTimeP95Ms: percentileAsc(sorted, 95),
        frameTimeP99Ms: percentileAsc(sorted, 99),
        longFrames,
        ...(dpr !== undefined ? { dpr } : {}),
      });
      windowStart = now;
      frameTimes = [];
    };

    let rafId: number | undefined;
    const tick = () => {
      if (disposed) return;
      const now = ctx.now();
      frameTimes.push(now - last);
      last = now;
      if (now - windowStart >= perfWindowMs) flushPerf(now);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    teardowns.push(() => {
      if (rafId !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
    });
  }

  // --- Error capture (window error + unhandledrejection → runtime_error) ---
  if (want.errors && typeof addEventListener === "function") {
    const onError = (raw: unknown) => {
      const e = raw as {
        message?: unknown;
        filename?: unknown;
        lineno?: unknown;
        colno?: unknown;
        error?: { stack?: unknown };
      };
      const message = typeof e.message === "string" ? e.message : "error";
      ctx.emit({
        type: "runtime_error",
        kind: "error",
        message: message.slice(0, 1024),
        ...(typeof e.filename === "string" ? { source: e.filename.slice(0, 1024) } : {}),
        ...(typeof e.lineno === "number" ? { lineno: e.lineno } : {}),
        ...(typeof e.colno === "number" ? { colno: e.colno } : {}),
        ...(typeof e.error?.stack === "string" ? { stack: e.error.stack.slice(0, 4096) } : {}),
      });
    };
    const onRejection = (raw: unknown) => {
      const e = raw as { reason?: unknown };
      const reason = e.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "unhandledrejection";
      ctx.emit({
        type: "runtime_error",
        kind: "unhandledrejection",
        message: String(message).slice(0, 1024),
        ...(reason instanceof Error && typeof reason.stack === "string"
          ? { stack: reason.stack.slice(0, 4096) }
          : {}),
      });
    };
    addEventListener("error", onError);
    addEventListener("unhandledrejection", onRejection);
    teardowns.push(() => {
      removeEventListener("error", onError);
      removeEventListener("unhandledrejection", onRejection);
    });
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const t of teardowns) t();
  };
}
