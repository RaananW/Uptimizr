import { defineConfig } from "vitest/config";

// `trackUnity` starts a real client whose lifecycle + JS-only capture tier attach DOM
// listeners and read `requestAnimationFrame`, so the integration tests need a
// browser-like environment. No real WebGL or Unity export is involved (the engine
// bridge is pushed synthetically), so jsdom is sufficient.
export default defineConfig({
  test: { environment: "jsdom" },
});
