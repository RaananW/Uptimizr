/**
 * Virtual module provided by the `uptimizr-scene-projects` Vite plugin
 * (see `vite.config.ts`). Maps a scene id to the collector project bound to it,
 * derived from `.uptimizr/projects.json`. Empty when no registry exists.
 */
declare module "virtual:uptimizr-scene-projects" {
  const bindings: Record<string, { projectId: string; apiKey: string }>;
  export default bindings;
}
