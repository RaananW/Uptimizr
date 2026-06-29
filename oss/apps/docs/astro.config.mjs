// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  site: "https://uptimizr.com",
  base: "/docs",
  integrations: [
    starlight({
      title: "Uptimizr Docs",
      description:
        "Documentation for Uptimizr — open-source, privacy-first analytics for 3D scenes.",
      logo: {
        src: "./src/assets/logo-lockup.svg",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/theme.css"],
      components: {
        // Inject Vercel Web Analytics into every page's <head>.
        Head: "./src/components/Head.astro",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/RaananW/Uptimizr",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/RaananW/Uptimizr/edit/main/oss/apps/docs/",
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Introduction", slug: "introduction" },
            { label: "Quickstart", slug: "quickstart" },
            { label: "Concepts", slug: "concepts" },
            { label: "Contributing", slug: "contributing" },
          ],
        },
        {
          label: "SDK & connectors",
          items: [
            { label: "Overview", slug: "connectors/overview" },
            { label: "Install via CDN / script tag", slug: "connectors/cdn" },
            { label: "Playgrounds & online editors", slug: "connectors/playgrounds" },
            { label: "Babylon.js", slug: "connectors/babylon" },
            { label: "Babylon Lite", slug: "connectors/babylon-lite" },
            { label: "three.js", slug: "connectors/three" },
            { label: "PlayCanvas", slug: "connectors/playcanvas" },
            { label: "react-three-fiber", slug: "connectors/r3f" },
            { label: "A-Frame", slug: "connectors/aframe" },
            { label: "Web exports (Unity/Godot/Unreal)", slug: "connectors/web-export" },
            { label: "Unity", slug: "connectors/unity" },
            { label: "Godot", slug: "connectors/godot" },
            { label: "Unreal", slug: "connectors/unreal" },
            { label: "sdk-core (advanced)", slug: "connectors/sdk-core" },
          ],
        },
        {
          label: "Capturing data",
          items: [
            { label: "Configuration reference", slug: "guides/configuration" },
            { label: "Mesh & object tracking", slug: "guides/mesh-tracking" },
            { label: "Custom events & input", slug: "guides/events" },
            { label: "Multi-scene experiences", slug: "guides/multi-scene" },
            { label: "Sessions & lifecycle", slug: "guides/sessions" },
            { label: "Performance & diagnostics", slug: "guides/performance" },
          ],
        },
        {
          label: "Using your data",
          items: [
            { label: "Session replay", slug: "guides/replay" },
            { label: "In-scene heatmap overlays", slug: "guides/overlays" },
            { label: "Custom dashboard panels", slug: "guides/custom-panels" },
            { label: "MCP server (AI agents)", slug: "guides/mcp" },
          ],
        },
        {
          label: "HTTP API",
          items: [
            { label: "Overview & auth", slug: "api/overview" },
            { label: "Ingestion", slug: "api/ingestion" },
            { label: "Query endpoints", slug: "api/query" },
          ],
        },
        {
          label: "Deploy & self-host",
          items: [
            { label: "Run the collector", slug: "deploy/collector" },
            { label: "Serve the dashboard", slug: "deploy/dashboard" },
            { label: "Privacy & configuration", slug: "deploy/privacy" },
          ],
        },
      ],
    }),
  ],
});
