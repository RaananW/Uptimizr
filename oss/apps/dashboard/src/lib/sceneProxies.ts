// Whole-building scene-proxy backdrop (ADR 0040 §5).
//
// A large scene is split into per-section scenes, each with its own scoped proxy
// (the ground/walls live in the overview scene; each elevated level + its props
// live in that level's scene). When the dashboard isn't pinned to a single area,
// the 3D backdrops should show the WHOLE building at once — deterministically —
// rather than swapping to (or accumulating) one section at a time as the live
// avatar crosses invisible boundaries. This helper lists every active area and
// merges their proxy meshes into one set, de-duplicated by name (a mesh that
// bridges two areas — a ramp/stairway — is registered in both, so dedup keeps a
// single copy).

import type { CollectorApi, QueryParams, SceneProxyMesh } from "@/lib/api";

/**
 * Fetch and merge the registered proxy geometry for every active scene/area into
 * one backdrop (the whole building). Returns [] when nothing is registered. Errors
 * on individual areas are ignored so one missing representation never blanks the
 * whole backdrop.
 */
export async function mergeSceneProxies(
  api: CollectorApi,
  params?: QueryParams,
): Promise<SceneProxyMesh[]> {
  const scenes = await api.scenes(params).catch(() => []);
  if (scenes.length === 0) return [];
  const reps = await Promise.all(
    scenes.map((s) => api.sceneRepresentation(s.scene_id).catch(() => null)),
  );
  const seen = new Set<string>();
  const merged: SceneProxyMesh[] = [];
  for (const rep of reps) {
    for (const mesh of rep?.proxy?.meshes ?? []) {
      if (seen.has(mesh.name)) continue;
      seen.add(mesh.name);
      merged.push(mesh);
    }
  }
  return merged;
}
