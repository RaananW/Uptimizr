/**
 * `@uptimizr/replay` — re-drive a captured session in the user's own 3D scene.
 *
 * The core (`ReplayPlayer`, `fetchSessionEvents`) is framework-agnostic. Engine
 * drivers live behind subpaths, e.g. `@uptimizr/replay/babylon`. A replay driver
 * only reads/writes the scene — it never emits analytics events (ADR 0006).
 */

export { ReplayPlayer } from "./player.js";
export { fetchSessionEvents, fetchSessionEventsStream } from "./fetchSession.js";
export type { FetchSessionOptions, StreamSessionOptions } from "./fetchSession.js";
export type { ReplayDriver, ReplayOptions, ReplayHandle, PlayerEnv } from "./types.js";
export { reconstructRigidSubtree } from "./reconstruct.js";
export type {
  ReconstructRigidSubtreeOptions,
  ReconstructedMesh,
  RigidTransform,
  RootTransform,
  Vec3 as ReconstructVec3,
  Quat as ReconstructQuat,
} from "./reconstruct.js";
