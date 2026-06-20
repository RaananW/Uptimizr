import type { AppBase } from "playcanvas";
import type { Graphics, GraphicsApi, GraphicsBackend, ShadingLanguage } from "@uptimizr/schema";
import { isWebGl2, isWebGpu, readGlInfo } from "./renderer.js";

/** Structural view of the PlayCanvas app fields we read for graphics metadata. */
interface AppDeviceView {
  graphicsDevice?: unknown;
}

/**
 * Best-effort mapping of an unmasked renderer string to the real backend behind
 * the API. WebGL on the web is almost always served through ANGLE, whose renderer
 * string names the underlying driver (e.g. `Direct3D11`, `Metal`, `Vulkan`). This
 * is the only honest signal available without privileged adapter info, so treat
 * the result as a hint and fall back to `undefined` when nothing matches.
 *
 * Shared heuristic with the Babylon / three connectors — the renderer string is
 * engine independent (it comes from the browser's WebGL implementation).
 */
function backendFromRenderer(renderer: string | undefined): GraphicsBackend | undefined {
  if (!renderer) return undefined;
  if (/Direct3D11|D3D11/i.test(renderer)) return "d3d11";
  if (/Direct3D12|D3D12/i.test(renderer)) return "d3d12";
  if (/Metal/i.test(renderer)) return "metal";
  if (/Vulkan/i.test(renderer)) return "vulkan";
  if (/OpenGL ES/i.test(renderer)) return "opengles";
  if (/OpenGL/i.test(renderer)) return "opengl";
  return undefined;
}

/**
 * Read the {@link Graphics} backend block from a PlayCanvas app (ADR 0021),
 * normalized into the schema. Captures the rendering API surface, the real backend
 * beneath it when discoverable, the API/driver version, and the shading language.
 *
 * This generalizes {@link "./device".readDeviceCaps}'s coarse `engine` field. All
 * fields are best-effort: on the web, `backend` is inferred from the unmasked
 * renderer string (via ANGLE) and may be `undefined` when the browser withholds it.
 *
 * Pass the result to `client.start({ graphics })` so it rides along on the
 * `session_start` event. `trackScene` does this automatically.
 */
export function readGraphics(app: AppBase): Graphics {
  const device = (app as unknown as AppDeviceView).graphicsDevice;
  const webgpu = isWebGpu(device);
  const glInfo = readGlInfo(device);

  const api: GraphicsApi = webgpu ? "webgpu" : isWebGl2(device) ? "webgl2" : "webgl";

  const shadingLanguage: ShadingLanguage = webgpu ? "wgsl" : "glsl-es";

  const graphics: Graphics = { api, shadingLanguage };

  // WebGPU's real backend (Metal/D3D12/Vulkan) isn't exposed by PlayCanvas' public
  // API; for WebGL we infer it from the ANGLE renderer string.
  const backend = webgpu ? undefined : backendFromRenderer(glInfo.renderer);
  if (backend) graphics.backend = backend;
  if (glInfo.version) graphics.apiVersion = glInfo.version;

  return graphics;
}
