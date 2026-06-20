import type { AppBase } from "playcanvas";
import type { Device } from "@uptimizr/schema";
import { isWebGl2, isWebGpu, maxTextureSize, readGlInfo } from "./renderer.js";

interface NavigatorView {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
}

/** Structural view of the PlayCanvas app fields we read for device caps. */
interface AppDeviceView {
  graphicsDevice?: unknown;
}

/**
 * Read GPU / device capabilities from a PlayCanvas app, normalized into the
 * schema's {@link Device} block. Covers both the WebGL2 and WebGPU backends behind
 * `app.graphicsDevice`.
 *
 * Unlike Babylon's engine, PlayCanvas has no single caps object — vendor/renderer
 * come from the WebGL context (`device.gl` + `WEBGL_debug_renderer_info`) and
 * `maxTextureSize` from the device. All reads are best-effort.
 *
 * Pass the result to `client.start({ device })` so it rides along on the
 * `session_start` event (the SDK emits that before collectors start, so this is a
 * standalone helper rather than part of the collector).
 */
export function readDeviceCaps(app: AppBase): Device {
  const device = (app as unknown as AppDeviceView).graphicsDevice;
  const glInfo = readGlInfo(device);
  const nav: NavigatorView | undefined =
    typeof navigator !== "undefined" ? (navigator as NavigatorView) : undefined;

  const engine: Device["engine"] = isWebGpu(device)
    ? "webgpu"
    : isWebGl2(device)
      ? "webgl2"
      : "webgl";

  const caps: Device = { engine };
  if (glInfo.vendor) caps.vendor = glInfo.vendor;
  if (glInfo.renderer) caps.renderer = glInfo.renderer;
  const maxTex = maxTextureSize(device);
  if (typeof maxTex === "number") caps.maxTextureSize = maxTex;
  if (typeof nav?.hardwareConcurrency === "number")
    caps.hardwareConcurrency = nav.hardwareConcurrency;
  if (typeof nav?.deviceMemory === "number") caps.deviceMemoryGb = nav.deviceMemory;
  if (nav?.userAgent) caps.isMobile = /Mobi|Android|iPhone|iPad/i.test(nav.userAgent);

  return caps;
}
