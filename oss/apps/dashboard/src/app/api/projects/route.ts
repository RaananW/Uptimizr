import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Reads the local, gitignored project registry written by `pnpm playground:new`
// (and the `pnpm playground` launcher) so the dashboard can offer a project
// picker without ever calling the collector. This is a local-dev convenience:
// in a deployed dashboard neither the env var nor the fallback file exists, so
// the endpoint simply returns an empty list.
//
// `force-static` keeps the route compatible with a static export
// (`DASHBOARD_STATIC=1`), where it is rendered once at build time (yielding an
// empty list when no registry is present). Under `next dev` the handler still
// runs per request, so the live registry is picked up during local dev.
export const runtime = "nodejs";
export const dynamic = "force-static";

interface SceneMeta {
  id: string;
  label: string;
  description: string;
  cameraMode: "viewer" | "first-person";
  engines: string[];
  defaultEngine: string;
  builtin: boolean;
}

interface ProjectEntry {
  id: string;
  name: string;
  apiKey: string;
  scene?: SceneMeta;
}

function registryPath(): string {
  return (
    process.env.UPTIMIZR_PROJECTS_FILE ?? resolve(process.cwd(), "../../../.uptimizr/projects.json")
  );
}

/** Validate + normalize a raw registry `scene` blob, or return `undefined`. */
function parseScene(value: unknown): SceneMeta | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== "string" || s.id.length === 0) return undefined;
  const cameraMode = s.cameraMode === "first-person" ? "first-person" : "viewer";
  const engines = Array.isArray(s.engines)
    ? s.engines.filter((e): e is string => typeof e === "string")
    : [];
  return {
    id: s.id,
    label: typeof s.label === "string" ? s.label : s.id,
    description: typeof s.description === "string" ? s.description : "",
    cameraMode,
    engines,
    defaultEngine: typeof s.defaultEngine === "string" ? s.defaultEngine : (engines[0] ?? ""),
    builtin: s.builtin === true,
  };
}

export function GET(): Response {
  // A static export (`DASHBOARD_STATIC=1`) is rendered once at build time and
  // shipped as a distributable artifact. Never bake the build machine's local
  // registry (which holds real API keys) into it — always return an empty list.
  if (process.env.DASHBOARD_STATIC === "1") return Response.json([]);

  // Hermetic test/automation harnesses set this to ignore the developer's local
  // registry, so the dashboard uses the API key field directly instead of
  // auto-selecting a registry project (which would override the supplied key).
  if (process.env.UPTIMIZR_DISABLE_SCENE_REGISTRY === "1") return Response.json([]);

  const path = registryPath();
  if (!existsSync(path)) return Response.json([]);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return Response.json([]);
    const list: ProjectEntry[] = parsed
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .filter((e) => e.id != null && e.apiKey != null)
      .map((e) => {
        const scene = parseScene(e.scene);
        return {
          id: String(e.id),
          name: String(e.name ?? e.id),
          apiKey: String(e.apiKey),
          ...(scene ? { scene } : {}),
        };
      });
    return Response.json(list);
  } catch {
    return Response.json([]);
  }
}
