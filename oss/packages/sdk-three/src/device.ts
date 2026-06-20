import type { WebGLRenderer } from "three";
import type { Device } from "@uptimizr/schema";
import { isWebGl2, isWebGpu, maxTextureSize, readGlInfo } from "./renderer.js";

interface NavigatorView {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
}

/**
 * Read GPU / device capabilities from a three.js renderer, normalized into the
 * schema's {@link Device} block. Covers `WebGLRenderer` (WebGL2/WebGL) and
 * `WebGPURenderer`.
 *
 * Unlike Babylon's engine, three has no single caps object — vendor/renderer come
 * from the WebGL context (`getContext()` + `WEBGL_debug_renderer_info`) and
 * `maxTextureSize` from `renderer.capabilities`. All reads are best-effort.
 *
 * Pass the result to `client.start({ device })` so it rides along on the
 * `session_start` event (the SDK emits that before collectors start, so this is a
 * standalone helper rather than part of the collector).
 */
export function readDeviceCaps(renderer: WebGLRenderer): Device {
  const glInfo = readGlInfo(renderer);
  const nav: NavigatorView | undefined =
    typeof navigator !== "undefined" ? (navigator as NavigatorView) : undefined;

  const engine: Device["engine"] = isWebGpu(renderer)
    ? "webgpu"
    : isWebGl2(renderer)
      ? "webgl2"
      : "webgl";

  const device: Device = { engine };
  if (glInfo.vendor) device.vendor = glInfo.vendor;
  if (glInfo.renderer) device.renderer = glInfo.renderer;
  const maxTex = maxTextureSize(renderer);
  if (typeof maxTex === "number") device.maxTextureSize = maxTex;
  if (typeof nav?.hardwareConcurrency === "number")
    device.hardwareConcurrency = nav.hardwareConcurrency;
  if (typeof nav?.deviceMemory === "number") device.deviceMemoryGb = nav.deviceMemory;
  if (nav?.userAgent) device.isMobile = /Mobi|Android|iPhone|iPad/i.test(nav.userAgent);

  return device;
}
