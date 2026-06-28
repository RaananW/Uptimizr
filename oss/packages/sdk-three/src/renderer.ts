/**
 * Defensive readers for a three.js renderer's underlying graphics context. Shared
 * by {@link "./device".readDeviceCaps} and {@link "./graphics".readGraphics}.
 *
 * three exposes two renderer families — `WebGLRenderer` and (newer) `WebGPURenderer`
 * — with different surfaces across versions, so we read structurally via minimal
 * views rather than binding to concrete classes (which would also force a runtime
 * dependency on `three`).
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

interface RendererContextView {
  /** `true` on a three `WebGPURenderer`. */
  isWebGPURenderer?: boolean;
  getContext?: () => unknown;
  capabilities?: { isWebGL2?: boolean; maxTextureSize?: number };
}

export interface GlInfo {
  vendor?: string;
  renderer?: string;
  version?: string;
}

/** True when the renderer is a three `WebGPURenderer`. */
export function isWebGpu(renderer: unknown): boolean {
  return (renderer as RendererContextView).isWebGPURenderer === true;
}

/**
 * True when a `WebGLRenderer` could not obtain a GL context — `getContext()`
 * returns null. WebGPU renderers have no `getContext` and are never flagged here
 * (a failed adapter surfaces as device-lost). Best-effort: any throw is treated as
 * a present context so we never false-positive a creation failure.
 */
export function lacksGlContext(renderer: unknown): boolean {
  const view = renderer as RendererContextView;
  if (view.isWebGPURenderer || typeof view.getContext !== "function") return false;
  try {
    return view.getContext() == null;
  } catch {
    return false;
  }
}

/** Read `capabilities.maxTextureSize`, when exposed. */
export function maxTextureSize(renderer: unknown): number | undefined {
  const caps = (renderer as RendererContextView).capabilities;
  return typeof caps?.maxTextureSize === "number" ? caps.maxTextureSize : undefined;
}

/** True when the renderer reports a WebGL2 context (or no WebGL1 fallback). */
export function isWebGl2(renderer: unknown): boolean {
  const caps = (renderer as RendererContextView).capabilities;
  // three r163+ is WebGL2-only and may omit the flag — treat absence as WebGL2.
  return caps?.isWebGL2 !== false;
}

/**
 * Read vendor / renderer / version strings from the renderer's WebGL context,
 * preferring the **unmasked** strings exposed by `WEBGL_debug_renderer_info` (the
 * driver behind ANGLE) and falling back to the masked `VENDOR`/`RENDERER`. All
 * reads are best-effort: some contexts withhold these, and a `WebGPURenderer` has
 * no WebGL context at all — in which case an empty object is returned.
 */
export function readGlInfo(renderer: unknown): GlInfo {
  const view = renderer as RendererContextView;
  const gl = typeof view.getContext === "function" ? view.getContext() : undefined;
  if (!gl) return {};

  const c = gl as GlParamView;
  const info: GlInfo = {};
  try {
    const ext =
      typeof c.getExtension === "function" ? c.getExtension("WEBGL_debug_renderer_info") : null;
    const vendorParam = ext ? ext.UNMASKED_VENDOR_WEBGL : c.VENDOR;
    const rendererParam = ext ? ext.UNMASKED_RENDERER_WEBGL : c.RENDERER;
    const vendor = c.getParameter(vendorParam);
    const renderer2 = c.getParameter(rendererParam);
    const version = c.getParameter(c.VERSION);
    if (typeof vendor === "string" && vendor) info.vendor = vendor;
    if (typeof renderer2 === "string" && renderer2) info.renderer = renderer2;
    if (typeof version === "string" && version) info.version = version;
  } catch {
    // Best-effort: a context may disallow these reads. Leave fields unset.
  }
  return info;
}
