import { defineConfig } from "vitest/config";

// react-three-fiber renders React, so the connector's hook/component are exercised
// in a DOM environment. `useThree` and `@uptimizr/three` are stubbed in the tests
// (no real WebGL), so jsdom is sufficient — we never mount a live `<Canvas>`.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  // `@uptimizr/three`'s built dist and the tests would otherwise resolve two copies of
  // `three` (one per package's node_modules), which three reports as "Multiple
  // instances of Three.js being imported" on every run.
  resolve: { dedupe: ["three"] },
  test: { environment: "jsdom" },
});
