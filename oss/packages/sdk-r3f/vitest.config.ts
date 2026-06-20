import { defineConfig } from "vitest/config";

// react-three-fiber renders React, so the connector's hook/component are exercised
// in a DOM environment. `useThree` and `@uptimizr/three` are stubbed in the tests
// (no real WebGL), so jsdom is sufficient — we never mount a live `<Canvas>`.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: { environment: "jsdom" },
});
