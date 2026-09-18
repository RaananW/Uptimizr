// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";

// https://astro.build/config
export default defineConfig({
  site: "https://uptimizr.com",
  base: "/docs",
  integrations: [
    starlight({
      title: "Uptimizr Docs",
      description:
        "Documentation for Uptimizr — open-source, privacy-first analytics for 3D scenes.",
      // Emit /docs/llms.txt (an index) and /docs/llms-full.txt (every page, inlined)
      // at build time, so an agent can read the docs without crawling the HTML —
      // the site-level companion to the packaged `llms.txt` files (ADR 0017).
      plugins: [
        starlightLlmsTxt({
          projectName: "Uptimizr",
          description:
            "Open-source, privacy-first analytics for 3D scenes: view-direction and click " +
            "heatmaps, mesh interactions, navigation, performance, WebXR, session replay, and " +
            "an AI-first agent layer (semantic metric registry, OpenAPI, MCP server).",
          details: [
            "Self-hosted: a single Fastify collector writes to an embedded DuckDB file by default,",
            "with optional Postgres, SQL Server and ClickHouse stores. Connectors exist for",
            "Babylon.js, three.js, PlayCanvas, react-three-fiber, A-Frame and Unity/Godot/Unreal",
            "web exports.",
            "",
            "Agents: the collector's read API is generated from a semantic metric registry",
            "(`@uptimizr/metrics`), served as OpenAPI 3.1 at `/api/v1/openapi.json` and as MCP",
            "tools by `@uptimizr/mcp`. Prefer `format=summary` on aggregate reads.",
          ].join("\n"),
          optionalLinks: [
            {
              label: "GitHub repository",
              url: "https://github.com/RaananW/Uptimizr",
              description: "Source, ADRs, and the integration reference.",
            },
            {
              label: "Live demo",
              url: "https://demo.uptimizr.com",
              description: "Playground + dashboard running entirely in the browser.",
            },
          ],
        }),
      ],
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
          ],
        },
        {
          label: "AI & agents",
          items: [
            { label: "Building agents on Uptimizr", slug: "guides/agents" },
            { label: "MCP server (AI agents)", slug: "guides/mcp" },
            { label: "In-browser assistant (LLM)", slug: "guides/assistant" },
          ],
        },
        {
          label: "HTTP API",
          items: [
            { label: "Overview & auth", slug: "api/overview" },
            { label: "Ingestion", slug: "api/ingestion" },
            { label: "Query endpoints", slug: "api/query" },
            { label: "Metadata endpoints", slug: "api/metadata" },
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
