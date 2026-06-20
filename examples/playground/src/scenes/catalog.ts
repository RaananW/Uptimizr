// Loads + validates the committed scene catalog (`scenes.json`) and exposes small
// lookup helpers used by the bootstrap (`main.ts`) and the shared shell. The raw
// JSON is cast through `SceneDefinition` and lightly validated so a malformed
// entry fails fast at boot rather than rendering a broken selector.

import { ENGINE_CHOICES, isEngineId, type EngineId } from "../engine.js";
import rawScenes from "../../scenes.json";
import type { SceneDefinition } from "./types.js";

export type { SceneDefinition } from "./types.js";

function isCameraMode(value: unknown): value is SceneDefinition["cameraMode"] {
  return value === "viewer" || value === "first-person";
}

/** Validate one raw catalog entry, throwing on the first structural problem. */
function parseScene(entry: unknown, index: number): SceneDefinition {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`scenes.json[${index}] is not an object`);
  }
  const e = entry as Record<string, unknown>;
  const id = e.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`scenes.json[${index}].id must be a non-empty string`);
  }
  if (!isCameraMode(e.cameraMode)) {
    throw new Error(`scene "${id}" has an invalid cameraMode`);
  }
  if (!Array.isArray(e.engines) || e.engines.length === 0) {
    throw new Error(`scene "${id}" must list at least one engine`);
  }
  const engines = e.engines.filter((x): x is EngineId =>
    isEngineId(typeof x === "string" ? x : null),
  );
  if (engines.length !== e.engines.length) {
    throw new Error(`scene "${id}" lists an unknown engine id`);
  }
  if (!isEngineId(typeof e.defaultEngine === "string" ? e.defaultEngine : null)) {
    throw new Error(`scene "${id}" has an invalid defaultEngine`);
  }
  const defaultEngine = e.defaultEngine as EngineId;
  if (!engines.includes(defaultEngine)) {
    throw new Error(`scene "${id}" defaultEngine "${defaultEngine}" is not in its engines`);
  }
  return {
    id,
    label: typeof e.label === "string" ? e.label : id,
    description: typeof e.description === "string" ? e.description : "",
    cameraMode: e.cameraMode,
    engines,
    defaultEngine,
    builtin: e.builtin === true,
  };
}

/** The validated scene catalog, in catalog order. */
export const SCENES: readonly SceneDefinition[] = (rawScenes as unknown[]).map(parseScene);

/** The scene shown when none is requested (first in the catalog). */
export const DEFAULT_SCENE_ID: string = SCENES[0]?.id ?? "lobby";

/** Look up a scene by id, or `undefined` if it is not in the catalog. */
export function getScene(id: string | null): SceneDefinition | undefined {
  return id == null ? undefined : SCENES.find((s) => s.id === id);
}

/** True when `id` names a scene in the catalog. */
export function isSceneId(id: string | null): boolean {
  return getScene(id) !== undefined;
}

/** Engines that can render a scene, ordered as in {@link ENGINE_CHOICES}. */
export function enginesForScene(scene: SceneDefinition): EngineId[] {
  return ENGINE_CHOICES.map((c) => c.id).filter((id) => scene.engines.includes(id));
}
