// The scene catalog contract. A *scene* is a buildable demo experience the
// playground can render — keyed by a stable `id` that is **also** the `sceneId`
// the connector tags every event with (ADR 0010). Each scene fixes a camera mode
// (ADR 0026) and gets exactly one collector project (one project per scene), and
// declares which engines can render it. The catalog itself lives in the committed
// `scenes.json`; this module gives it a type and small lookup helpers.

import type { CameraMode, EngineId } from "../engine.js";

/** One entry in the scene catalog (`scenes.json`). */
export interface SceneDefinition {
  /** Stable id; also the connector `sceneId`. Used in `?scene=<id>`. */
  readonly id: string;
  /** Human label shown in the scene selector. */
  readonly label: string;
  /** One-line description shown under the label. */
  readonly description: string;
  /** Camera/navigation model the scene fixes (viewer = orbit, first-person = walk). */
  readonly cameraMode: CameraMode;
  /** Engines that can render this scene; the engine selector is constrained to these. */
  readonly engines: readonly EngineId[];
  /** Engine selected when none is requested (must be in `engines`). */
  readonly defaultEngine: EngineId;
  /**
   * Built-in scenes are rendered by the shared engine modules under `src/engines/`
   * (which already build the viewer/walkable scene from the camera mode). Scaffolded
   * scenes provide per-engine builder modules under `src/scenes/<id>/<engine>.ts`.
   */
  readonly builtin: boolean;
}
