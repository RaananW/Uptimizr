// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Marketing site served at the uptimizr.com apex (OSS only — no hosting/SaaS messaging).
// Static output; the interactive hero is a client-side Babylon island.
export default defineConfig({
  site: "https://uptimizr.com",
  output: "static",
  devToolbar: { enabled: false },
  build: { assets: "_assets" },
  integrations: [sitemap()],
});
