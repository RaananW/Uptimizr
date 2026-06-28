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

/**
 * Wire a WebGPU `GPUDevice.lost` into a `graphics_diagnostic` (ADR 0021 part 2,
 * `category: "device-lost"`). Engine-agnostic: every connector that has a WebGPU
 * device hands it here, so the gating, severity mapping, length-cap, and event
 * shape live in exactly one place.
 *
 * Behavior:
 * - **Opt-in gate.** No-ops unless `ctx.config.captureGraphicsDiagnostics` is on —
 *   nothing is wired and nothing is emitted when off. (Unlike `context_lost`,
 *   which is always-on; device loss is the richer opt-in diagnostic.)
 * - **Severity.** `info` when `reason === "destroyed"` (an expected, app-requested
 *   loss via `device.destroy()`); `fatal` otherwise (an unrequested loss —
 *   rendering cannot continue).
 * - **Marker.** Emits a single discrete incident (no `count`): device loss is rare
 *   and decisive, so the high-fidelity marker is the right default here.
 * - **Privacy.** The optional `message` is locally truncated to
 *   {@link LIMITS.maxGraphicsDiagnosticMessageLength} and rides through `ctx.emit`,
 *   which applies the client's `beforeSend` for deployer-owned redaction.
 *
 * `device.lost` is a one-shot promise that cannot be unsubscribed, so teardown is
 * cooperative: pass an `isActive` predicate (typically `() => !stopped`) and the
 * emit is suppressed if the collector has stopped by the time it resolves.
 *
 * @param ctx Collector context (config + `emit`).
 * @param device The WebGPU device, or `undefined`/`null` on WebGL or before init —
 *   in which case this is a no-op.
 * @param isActive Returns `false` once the collector has been torn down.
 */
export function wireGpuDeviceLost(
  ctx: CollectorContext,
  device: GpuDeviceLostLike | undefined | null,
  isActive: () => boolean,
): void {
  if (!ctx.config.captureGraphicsDiagnostics) return;
  const lost = device?.lost;
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
}
