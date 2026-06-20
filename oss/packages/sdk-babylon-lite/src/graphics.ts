import type { Graphics, GraphicsApi, GraphicsBackend, ShadingLanguage } from "@uptimizr/schema";

/**
 * Minimal structural view of the WebGPU adapter-info surface. Declared locally so
 * the connector doesn't pull in `@webgpu/types` (the host app owns WebGPU); only
 * the few fields we read are described, all optional and best-effort.
 */
interface GpuAdapterInfoView {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}
interface GpuAdapterView {
  /** Synchronous adapter-info getter (current WebGPU spec). */
  info?: GpuAdapterInfoView;
  /** Deprecated async adapter-info accessor (older Chromium). */
  requestAdapterInfo?: () => Promise<GpuAdapterInfoView>;
}
interface GpuView {
  requestAdapter?: (options?: unknown) => Promise<GpuAdapterView | null>;
}
interface NavigatorGpuView {
  gpu?: GpuView;
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/**
 * Best-effort mapping of a WebGPU adapter-info string (any of `architecture`,
 * `description`, `device`, `vendor`) to the real backend beneath WebGPU. Some
 * browsers name the driver/backend in these fields (e.g. `"D3D12"`, `"Metal"`,
 * `"Vulkan"`, `"metal-3"`); when they do this is the only adapter-reported signal.
 * Returns `undefined` when nothing matches so the caller can fall back to a
 * platform heuristic. Shared regex shape with the three connector's
 * `backendFromRenderer` (the tokens are driver names, engine-independent).
 */
function backendFromInfoString(s: string | undefined): GraphicsBackend | undefined {
  if (!s) return undefined;
  if (/Direct3D ?12|D3D12/i.test(s)) return "d3d12";
  if (/Direct3D ?11|D3D11/i.test(s)) return "d3d11";
  if (/Metal/i.test(s)) return "metal";
  if (/Vulkan/i.test(s)) return "vulkan";
  if (/OpenGL ?ES|GLES/i.test(s)) return "opengles";
  if (/OpenGL/i.test(s)) return "opengl";
  return undefined;
}

/**
 * Infer WebGPU's real backend from the host platform. WebGPU implementations pick
 * the backend by OS — Metal on Apple platforms, D3D12 on Windows, Vulkan on
 * Linux/Android/ChromeOS — so when the adapter info names no driver this is an
 * honest, low-cardinality fallback. Returns `undefined` when the platform is
 * unknown rather than guessing.
 */
function backendFromPlatform(nav: NavigatorGpuView | undefined): GraphicsBackend | undefined {
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? "";
  const ua = nav?.userAgent ?? "";
  const hay = `${platform} ${ua}`;
  if (/Mac|iPhone|iPad|iPod|iOS|Darwin/i.test(hay)) return "metal";
  if (/Win/i.test(hay)) return "d3d12";
  if (/Android|Linux|CrOS|X11/i.test(hay)) return "vulkan";
  return undefined;
}

/**
 * Read the {@link Graphics} backend block for a Babylon Lite scene (ADR 0021),
 * synchronously. Babylon Lite is a **WebGPU-only** engine, so the rendering API is
 * always `webgpu` and the shading language `wgsl`.
 *
 * The real backend beneath WebGPU (Metal / D3D12 / Vulkan) needs an async
 * `navigator.gpu` adapter round-trip and is therefore resolved by
 * {@link readGraphicsAsync}; this synchronous form leaves `backend` unset rather
 * than guessing. Use it when an async start isn't possible.
 *
 * Pass the result to `client.start({ graphics })` so it rides along on the
 * `session_start` event. {@link "./trackScene".trackScene} does this automatically.
 */
export function readGraphics(): Graphics {
  const api: GraphicsApi = "webgpu";
  const shadingLanguage: ShadingLanguage = "wgsl";
  return { api, shadingLanguage };
}

/** Read adapter info across the current (sync getter) and legacy (async) shapes. */
async function readAdapterInfo(adapter: GpuAdapterView): Promise<GpuAdapterInfoView | undefined> {
  if (adapter.info) return adapter.info;
  if (typeof adapter.requestAdapterInfo === "function") {
    try {
      return await adapter.requestAdapterInfo();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Resolve the {@link Graphics} backend block for a Babylon Lite scene with the
 * real WebGPU backend filled in (ADR 0021), via an async `navigator.gpu`
 * `requestAdapter()` round-trip. The backend (Metal / D3D12 / Vulkan) is taken
 * from the adapter's reported info when it names a driver, otherwise inferred from
 * the host platform; it is left unset when neither is conclusive.
 *
 * WebGPU exposes no standard API/driver version string, so `apiVersion` is left
 * unset rather than guessed. Always succeeds: any failure (no WebGPU, no adapter)
 * falls back to the synchronous {@link readGraphics} baseline.
 *
 * Await this before `client.start({ graphics })` so the resolved backend rides on
 * `session_start`. {@link "./trackScene".trackSceneAsync} does this for you.
 */
export async function readGraphicsAsync(): Promise<Graphics> {
  const graphics = readGraphics();
  const nav: NavigatorGpuView | undefined =
    typeof navigator !== "undefined" ? (navigator as NavigatorGpuView) : undefined;
  const gpu = nav?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") return graphics;

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return graphics;
    const info = await readAdapterInfo(adapter);
    const backend =
      backendFromInfoString(info?.architecture) ??
      backendFromInfoString(info?.description) ??
      backendFromInfoString(info?.device) ??
      backendFromInfoString(info?.vendor) ??
      backendFromPlatform(nav);
    if (backend) graphics.backend = backend;
  } catch {
    // Best-effort: keep the WebGPU/WGSL baseline on any adapter failure.
  }
  return graphics;
}
