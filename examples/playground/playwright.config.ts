import { defineConfig, devices } from "@playwright/test";
import {
  API_KEY,
  COLLECTOR_PORT,
  COLLECTOR_URL,
  DASHBOARD_PORT,
  DASHBOARD_URL,
  DUCKDB_PATH,
  PLAYGROUND_PORT,
  PLAYGROUND_URL,
  PROJECT_ID,
} from "./e2e/constants.js";

/**
 * End-to-end harness for the consolidated playground + dashboard. Three servers
 * are booted for the run:
 *
 * 1. **Collector** against the OSS single-file **DuckDB store** (ADR 0020) — full
 *    analytics, zero external services. The store is provisioned deterministically
 *    by `e2e/seed.ts`, chained with `&&` so it closes its single-writer handle
 *    before the collector opens the same file.
 * 2. **Playground** (Vite) — selects an engine via `?engine=<id>`; one server
 *    serves every engine, so the specs drive each from one origin.
 * 3. **Dashboard** (Next.js dev) — pointed at the collector via `NEXT_PUBLIC_*`,
 *    so the dashboard spec can verify captured events render in the UI.
 *
 * Prerequisite: run `pnpm build` first so the workspace packages compile, and
 * `pnpm --filter @uptimizr/example-playground test:e2e:install` once to fetch the
 * Chromium binary.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: PLAYGROUND_URL,
    trace: "on-first-retry",
    // When watching a headed run (`pnpm test:e2e:headed`), set E2E_SLOWMO to a
    // millisecond delay (e.g. `E2E_SLOWMO=250`) to slow each action down enough
    // to follow along. Defaults to 0 (full speed) for headless/CI runs.
    launchOptions: { slowMo: Number(process.env.E2E_SLOWMO ?? 0) },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], hasTouch: true },
    },
  ],
  webServer: [
    {
      // Seed the DuckDB store first (single-writer: it must close before the
      // collector opens the file), then boot the collector against it.
      command: `pnpm --filter @uptimizr/example-playground exec tsx e2e/seed.ts && pnpm --filter @uptimizr/collector-server exec tsx src/server.ts`,
      port: COLLECTOR_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        VISITOR_HASH_SECRET: "e2e-secret",
        COLLECTOR_STORE: "duckdb",
        DUCKDB_PATH,
        COLLECTOR_HOST: "127.0.0.1",
        COLLECTOR_PORT: String(COLLECTOR_PORT),
        COLLECTOR_CORS_ORIGINS: `${PLAYGROUND_URL},${DASHBOARD_URL}`,
        ENABLE_RAW_SESSION_RETENTION: "1",
      },
    },
    {
      command: `pnpm --filter @uptimizr/example-playground exec vite --port ${PLAYGROUND_PORT} --strictPort`,
      port: PLAYGROUND_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        VITE_COLLECTOR_URL: COLLECTOR_URL,
        VITE_PROJECT_ID: PROJECT_ID,
        VITE_API_KEY: API_KEY,
        // The first-person scene routes to the "walkable" project. Pin it to the
        // seeded e2e project so a developer's repo-root `.env` (which Vite also
        // loads) can't leak a locally provisioned walkable project into the run.
        VITE_PROJECT_ID_WALKABLE: PROJECT_ID,
        VITE_API_KEY_WALKABLE: API_KEY,
        // Keep the harness hermetic: ignore any local `.uptimizr/projects.json`
        // so built-in scenes route to the seeded `VITE_PROJECT_ID`, not a
        // developer's locally provisioned per-scene projects.
        UPTIMIZR_DISABLE_SCENE_REGISTRY: "1",
      },
    },
    {
      command: `pnpm --filter @uptimizr/dashboard exec next dev --port ${DASHBOARD_PORT}`,
      port: DASHBOARD_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NEXT_PUBLIC_COLLECTOR_URL: COLLECTOR_URL,
        NEXT_PUBLIC_API_KEY: API_KEY,
        // Ignore the developer's local `.uptimizr/projects.json` so the dashboard
        // uses the supplied API key directly instead of auto-selecting a registry
        // project (whose key isn't seeded here → live-token 401). Keeps the
        // harness hermetic, mirroring the playground's scene-registry opt-out.
        UPTIMIZR_DISABLE_SCENE_REGISTRY: "1",
      },
    },
  ],
});
