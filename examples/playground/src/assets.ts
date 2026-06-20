// Resolve a bundled `public/` asset to a URL that works regardless of the base
// path the playground is served under. In standalone dev it's served at the
// origin root (base `/`), but the in-browser demo serves it under `/playground/`
// — so an absolute `/models/x.glb` would 404 there. `import.meta.env.BASE_URL`
// carries the build-time base (`/` or `/playground/`), so we resolve against it.

/** Resolve a `public/`-relative asset path (e.g. `models/ToyCar.glb`) to a URL. */
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
