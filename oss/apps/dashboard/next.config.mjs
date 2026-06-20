/** @type {import('next').NextConfig} */
// Set `DASHBOARD_STATIC=1` to produce a self-contained static export (`out/`)
// that the collector can serve as an all-in-one bundle. In that mode there is
// no Next server, so build-time rewrites don't apply — the static host (the
// collector) is responsible for the SPA deep-link fallback.
const isStatic = process.env.DASHBOARD_STATIC === "1";

// Optional sub-path the static export is served under (e.g. `/dashboard` when the
// embedded demo mounts the dashboard beside the playground on one origin). Only
// applied when set, so the default root-served build is unaffected.
const basePath = process.env.NEXT_BASE_PATH || undefined;

const nextConfig = {
  reactStrictMode: true,
  ...(isStatic ? { output: "export" } : {}),
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  // Linting runs as its own Turborepo task (`pnpm lint`) with the repo's flat
  // ESLint config. Next 16 removed the build-time lint pass, so no `eslint`
  // key is needed here.
  //
  // The dashboard is a single client-rendered page that mirrors its
  // project/session selection into the URL (`/projects/:id`,
  // `/projects/:id/session/:sid`). Rewrite those deep links back to the root
  // page so a refresh or shared link resolves instead of 404-ing. Static
  // exports skip this (rewrites need a server); the collector serves the SPA
  // fallback for those paths instead.
  ...(isStatic
    ? {}
    : {
        async rewrites() {
          return [
            { source: "/projects/:projectId", destination: "/" },
            { source: "/projects/:projectId/session/:sessionId", destination: "/" },
          ];
        },
      }),
};

export default nextConfig;
