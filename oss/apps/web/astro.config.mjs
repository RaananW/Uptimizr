// @ts-check
import { URL } from "node:url";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

/**
 * The date each page's content last changed, keyed by pathname, for the sitemap's `lastmod`.
 * Bump a date when you change what that page says, not for formatting or typo fixes. It is set by
 * hand rather than taken from the build time or `git log`: a date that moves on every deploy, or a
 * shallow clone's boundary commit, would claim changes that didn't happen, and search engines stop
 * trusting `lastmod` on sites where it doesn't match the content.
 */
const LAST_UPDATED_BY_PATH = new Map([["/", "2026-11-06"]]);

// Marketing site served at the uptimizr.com apex (OSS only — no hosting/SaaS messaging).
// Static output; the interactive hero is a client-side Babylon island.
export default defineConfig({
  site: "https://www.uptimizr.com",
  output: "static",
  devToolbar: { enabled: false },
  build: { assets: "_assets" },
  integrations: [
    sitemap({
      serialize(item) {
        const lastmod = LAST_UPDATED_BY_PATH.get(new URL(item.url).pathname);
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
  ],
});
