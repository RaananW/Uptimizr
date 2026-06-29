import { defineConfig } from "vitest/config";

// `@babylonjs/lite` reads WebGPU bitmask globals at import time, which Node
// doesn't provide. The setup file stubs them so the engine can be imported in
// the Node test runner. See `src/__tests__/webgpu-globals.ts`.
export default defineConfig({
  test: { setupFiles: ["./src/__tests__/webgpu-globals.ts"] },
});
