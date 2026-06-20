/**
 * Defensive readers for a PlayCanvas graphics device's underlying graphics
 * context. Shared by {@link "./device".readDeviceCaps} and
 * {@link "./graphics".readGraphics}.
 *
 * PlayCanvas exposes one `GraphicsDevice` with two backends — `WebglGraphicsDevice`
 * and `WebgpuGraphicsDevice` — whose surfaces differ, so we read structurally via
 * minimal views rather than binding to concrete classes (which would also force a
 * runtime dependency on `playcanvas`).
 */

/** Minimal view of the WebGL context fields we read for GPU introspection. */
interface GlParamView {
  VENDOR: number;
  RENDERER: number;
  VERSION: number;
  getParameter(p: number): unknown;
  getExtension(name: string): {
    UNMASKED_VENDOR_WEBGL: number;
    UNMASKED_RENDERER_WEBGL: number;
  } | null;
}

/** Minimal structural view of `app.graphicsDevice`. */
export interface GraphicsDeviceView {
  /** `true` on a PlayCanvas `WebgpuGraphicsDevice`. */
  isWebGPU?: boolean;
  /** `true` on a WebGL2 device. */
  isWebGL2?: boolean;
  /** Maximum 2D texture size, when reported. */
  maxTextureSize?: number;
  /** The WebGL rendering context (present on `WebglGraphicsDevice`). */
  gl?: unknown;
  /** The backing canvas element. */
  canvas?: { width?: number; height?: number; clientWidth?: number; clientHeight?: number };
}

export interface GlInfo {
  vendor?: string;
  renderer?: string;
  version?: string;
}

/** True when the device is a PlayCanvas `WebgpuGraphicsDevice`. */
export function isWebGpu(device: unknown): boolean {
  return (device as GraphicsDeviceView).isWebGPU === true;
}

/** Read `maxTextureSize`, when exposed. */
export function maxTextureSize(device: unknown): number | undefined {
  const max = (device as GraphicsDeviceView).maxTextureSize;
  return typeof max === "number" ? max : undefined;
}

/** True when the device reports a WebGL2 context (or no WebGL1 fallback). */
export function isWebGl2(device: unknown): boolean {
  const view = device as GraphicsDeviceView;
  if (view.isWebGPU) return false;
  // PlayCanvas 2.x is WebGL2-only on the WebGL path and may omit the flag — treat
  // absence as WebGL2.
  return view.isWebGL2 !== false;
}

/**
 * Read vendor / renderer / version strings from the device's WebGL context,
 * preferring the **unmasked** strings exposed by `WEBGL_debug_renderer_info` (the
 * driver behind ANGLE) and falling back to the masked `VENDOR`/`RENDERER`. All
 * reads are best-effort: some contexts withhold these, and a WebGPU device has no
 * WebGL context at all — in which case an empty object is returned.
 */
export function readGlInfo(device: unknown): GlInfo {
  const view = device as GraphicsDeviceView;
  const gl = view.gl;
  if (!gl) return {};

  const c = gl as GlParamView;
  const info: GlInfo = {};
  try {
    const ext =
      typeof c.getExtension === "function" ? c.getExtension("WEBGL_debug_renderer_info") : null;
    const vendorParam = ext ? ext.UNMASKED_VENDOR_WEBGL : c.VENDOR;
    const rendererParam = ext ? ext.UNMASKED_RENDERER_WEBGL : c.RENDERER;
    const vendor = c.getParameter(vendorParam);
    const renderer = c.getParameter(rendererParam);
    const version = c.getParameter(c.VERSION);
    if (typeof vendor === "string" && vendor) info.vendor = vendor;
    if (typeof renderer === "string" && renderer) info.renderer = renderer;
    if (typeof version === "string" && version) info.version = version;
  } catch {
    // Best-effort: a context may disallow these reads. Leave fields unset.
  }
  return info;
}
