import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The dashboard's unit tests are plain logic + lightweight panel-metadata checks.
// A `.tsx` registry pulls JSX, but the app tsconfig sets `jsx: "preserve"` (Next
// owns the real build), so the test transform must opt into the automatic React
// JSX runtime explicitly, and we mirror the Next `@/*` path alias. The dashboard
// otherwise has no vite/vitest config.
export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "react",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
