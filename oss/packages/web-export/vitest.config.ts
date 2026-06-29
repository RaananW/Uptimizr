import { defineConfig } from "vitest/config";

// The JS-only capture tier attaches pointer / error listeners to the DOM and reads
// `requestAnimationFrame`, so its tests need a browser-like environment. No real
// WebGL or engine is involved (the bridge is pushed synthetically), so jsdom is
// sufficient.
export default defineConfig({
  test: { environment: "jsdom" },
});
