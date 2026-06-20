import type { Device } from "@uptimizr/schema";

interface NavigatorView {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
}

/**
 * Read GPU / device capabilities for a Babylon Lite scene, normalized into the
 * schema's {@link Device} block. Babylon Lite renders exclusively through WebGPU,
 * so `engine` is always `"webgpu"`.
 *
 * Unlike `@babylonjs/core`, Lite exposes no synchronous vendor/renderer/limits
 * caps object (those live behind the async WebGPU adapter), so only the
 * browser-level navigator hints are read here. All reads are best-effort.
 *
 * Pass the result to `client.start({ device })` so it rides along on the
 * `session_start` event.
 */
export function readDeviceCaps(): Device {
  const nav: NavigatorView | undefined =
    typeof navigator !== "undefined" ? (navigator as NavigatorView) : undefined;

  const device: Device = { engine: "webgpu" };
  if (typeof nav?.hardwareConcurrency === "number")
    device.hardwareConcurrency = nav.hardwareConcurrency;
  if (typeof nav?.deviceMemory === "number") device.deviceMemoryGb = nav.deviceMemory;
  if (nav?.userAgent) device.isMobile = /Mobi|Android|iPhone|iPad/i.test(nav.userAgent);

  return device;
}
