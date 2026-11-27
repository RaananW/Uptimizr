import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke tests for the built in-browser demo (demo.uptimizr.com). The demo has no
 * server: the playground and dashboard run in two iframes, and a service worker
 * answers the collector API from DuckDB-Wasm. So these specs serve `dist/` with
 * `vite preview` and drive the whole thing in the browser.
 *
 * Prerequisite: `pnpm build` (the demo's `prebuild` copies the built playground
 * and dashboard into it).
 */
export default defineConfig({
  testDir: "./e2e",
  // `*.e2e.ts`, so the demo's Vitest run (which matches `*.spec.ts`) leaves them alone.
  testMatch: "**/*.e2e.ts",
  // A CI runner renders both iframes on SwiftShader; a locked case took 1.8 min there.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4320",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 900 },
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
      },
    },
  ],
  webServer: {
    command: "pnpm preview",
    port: 4320,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
