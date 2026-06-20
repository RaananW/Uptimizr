import type { Scene } from "@babylonjs/core";
import type { Device } from "@uptimizr/schema";

/**
 * Minimal view of the Babylon engine fields we read for device introspection.
 * Babylon's engine API differs across WebGL2 and WebGPU and across major
 * versions, so we read defensively rather than binding to one concrete type.
 */
interface EngineCapsView {
  isWebGPU?: boolean;
  webGLVersion?: number;
  getGlInfo?: () => { vendor?: string; renderer?: string };
  getCaps?: () => { maxTextureSize?: number };
}

interface NavigatorView {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
}

/**
 * Read GPU / device capabilities from a Babylon scene's engine, normalized into
 * the schema's {@link Device} block. Covers both WebGL2 and WebGPU.
 *
 * Pass the result to `client.start({ device })` so it rides along on the
 * `session_start` event (the SDK emits that before collectors start, so this is
 * a standalone helper rather than part of the collector).
 */
export function readDeviceCaps(scene: Scene): Device {
  const engine = scene.getEngine() as unknown as EngineCapsView;
  const glInfo = typeof engine.getGlInfo === "function" ? engine.getGlInfo() : undefined;
  const caps = typeof engine.getCaps === "function" ? engine.getCaps() : undefined;
  const nav: NavigatorView | undefined =
    typeof navigator !== "undefined" ? (navigator as NavigatorView) : undefined;

  const backend: Device["engine"] = engine.isWebGPU
    ? "webgpu"
    : engine.webGLVersion === 2
      ? "webgl2"
      : engine.webGLVersion === 1
        ? "webgl"
        : "unknown";

  const device: Device = { engine: backend };
  if (glInfo?.vendor) device.vendor = glInfo.vendor;
  if (glInfo?.renderer) device.renderer = glInfo.renderer;
  if (typeof caps?.maxTextureSize === "number") device.maxTextureSize = caps.maxTextureSize;
  if (typeof nav?.hardwareConcurrency === "number")
    device.hardwareConcurrency = nav.hardwareConcurrency;
  if (typeof nav?.deviceMemory === "number") device.deviceMemoryGb = nav.deviceMemory;
  if (nav?.userAgent) device.isMobile = /Mobi|Android|iPhone|iPad/i.test(nav.userAgent);

  return device;
}
