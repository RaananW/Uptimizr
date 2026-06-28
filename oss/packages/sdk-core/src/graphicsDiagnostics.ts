import { LIMITS } from "@uptimizr/schema";
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
