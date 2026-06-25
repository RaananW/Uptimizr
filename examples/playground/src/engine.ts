// The contract every engine module fulfils so the shared shell can drive it.
//
// The shell (src/shell.ts) owns ALL of the DOM and UX — connection status,
// reporting transport, capture-toggle panel, scene switcher, cursor overlay,
// replay/heatmap/proxy controls. Each engine module owns ONLY the parts that are
// genuinely engine-specific: building a demo scene, starting its real connector,
// and the small glue for picking, flashing, replay-driver and scene-proxy. This
// is what lets one playground serve five engines without N copies of the shell.

import type { Transport, UptimizrClient } from "@uptimizr/sdk-core";
import type { ReplayDriver } from "@uptimizr/replay";

/** The engines the playground can switch between. */
export type EngineId = "babylon" | "babylon-lite" | "three" | "playcanvas" | "r3f" | "aframe";

/** Static label used to populate the engine selector without loading an engine. */
export interface EngineChoice {
  readonly id: EngineId;
  readonly label: string;
}

/** Order shown in the engine selector. */
export const ENGINE_CHOICES: readonly EngineChoice[] = [
  { id: "babylon", label: "Babylon.js" },
  { id: "babylon-lite", label: "Babylon Lite" },
  { id: "three", label: "three.js" },
  { id: "playcanvas", label: "PlayCanvas" },
  { id: "r3f", label: "react-three-fiber" },
  { id: "aframe", label: "A-Frame (WebXR)" },
];

export const DEFAULT_ENGINE: EngineId = "babylon";

export function isEngineId(value: string | null): value is EngineId {
  return ENGINE_CHOICES.some((c) => c.id === value);
}

/**
 * The two camera/navigation models the playground can build, mirroring the two
 * ways 3D analytics is used (see ADR 0026):
 *
 * - `viewer` — an orbit/arc-rotate camera around a model. Analytics answers "how
 *   do people inspect this object, and how interesting is it?". Tags the session
 *   `cameraType: "arc-rotate"`.
 * - `first-person` — a walkable scene the visitor traverses (WASD + look). Analytics
 *   answers "where do people walk, what do they approach?". Tags `cameraType: "free"`.
 *
 * Camera mode is an init-time decision (it builds a different camera rig and scene),
 * so switching reloads the page — the same model as the engine + capture toggles.
 */
export type CameraMode = "viewer" | "first-person";

export const DEFAULT_CAMERA_MODE: CameraMode = "viewer";

export function isCameraMode(value: string | null): value is CameraMode {
  return value === "viewer" || value === "first-person";
}

/** Scene id reported by the viewer (orbit) scene. */
export const VIEWER_SCENE_ID = "lobby";
/** Scene id reported by the first-person walkable scene. */
export const WALKABLE_SCENE_ID = "atrium";

/** The default scene id for a camera mode (also the `sceneId` the connector tags). */
export function sceneIdForMode(mode: CameraMode): string {
  return mode === "first-person" ? WALKABLE_SCENE_ID : VIEWER_SCENE_ID;
}

/** One capture toggle the SDK can record; rendered as a checkbox in the panel. */
export interface CaptureFeature {
  readonly key: string;
  readonly label: string;
  readonly default: boolean;
}

/** Which shell features the selected engine supports (drives section visibility). */
export interface EngineCapabilities {
  /** Renders into the shared `#renderCanvas` (vanilla engines) vs. owning its DOM. */
  readonly sharedCanvas: boolean;
  /** Shows the capture-toggle panel (engines wired through a custom transport). */
  readonly capturePanel: boolean;
  /** Supports `client.setScene()` area switching. */
  readonly sceneSwitch: boolean;
  /**
   * Can build a walkable, first-person scene (vs. only the orbit/viewer scene).
   * Drives visibility of the camera-mode toggle. Engines without this always run
   * the viewer scene.
   */
  readonly walkable: boolean;
  /** Shows the on-canvas pointer/cursor overlay. */
  readonly cursorOverlay: boolean;
  /** Mirrors the live input source (mouse/touch/pen). */
  readonly inputSource: boolean;
  /** Can replay a recorded session in-scene. */
  readonly replay: boolean;
  /**
   * Can load an arbitrary asset (e.g. a `.glb`) into the scene as a replay
   * **backdrop** and re-drive a session over it. Babylon-only for now (the first
   * connector); other engines leave it unset.
   */
  readonly backdrop?: boolean;
  /** Can draw an in-scene 3D heatmap overlay. */
  readonly heatmap: boolean;
  /** Can scan + register a scene proxy. */
  readonly sceneProxy: boolean;
}

export type PointerKind = "pointer_move" | "pointer_click" | "pointer_down" | "pointer_up";

/** Shell callbacks the engine's replay driver drives (cursor overlay + status). */
export interface ReplayHooks {
  showCursor(screen: [number, number], type: PointerKind): void;
  setStatus(text: string): void;
}

/** Everything the shell hands an engine when it mounts. */
export interface EngineMountContext {
  /** Shared canvas (vanilla engines render here). */
  readonly canvas: HTMLCanvasElement;
  /** Container for engines that own their own DOM (r3f, A-Frame). */
  readonly container: HTMLElement;
  readonly collectorUrl: string;
  readonly projectId: string;
  readonly apiKey: string;
  /** Delivery-confirming transport (engines wire this into `trackScene`). */
  readonly transport: Transport;
  /** Resolved capture toggles (subset of the engine's `captureFeatures`). */
  readonly capture: Record<string, boolean>;
  /**
   * The scene id the connector tags every event with (ADR 0010). Each catalog
   * scene fixes this; engines must report `ctx.sceneId` (not a value derived from
   * the camera mode) so a scene can render under its own id.
   */
  readonly sceneId: string;
  /**
   * Which camera/navigation model to build. `viewer` (orbit) is the default;
   * `first-person` builds a walkable scene. Engines that don't declare the
   * `walkable` capability always receive `viewer`.
   */
  readonly cameraMode: CameraMode;
  /** Optional demo keyboard bindings (Babylon only). */
  readonly keyBindings?: Record<string, string>;
  /** Notify the shell that a demo box was picked (bumps the local click counter). */
  onBoxPick(name: string): void;
  /** Push a line of status text into the panel (used by the declarative A-Frame path). */
  onStatus(text: string): void;
}

/** A live, mounted engine the shell can drive. */
export interface EngineInstance {
  /** The live client, or `null` for the declarative A-Frame path. */
  readonly client: UptimizrClient | null;
  /** Briefly highlight a mesh by name (used for live picks and replay). */
  flashMesh(name: string): void;
  /** Build the engine-specific replay driver, wired to shell cursor/status hooks. */
  createReplayDriver?(hooks: ReplayHooks): ReplayDriver;
  /**
   * Load an asset (URL or dropped `File`, e.g. a `.glb`) into the scene as a replay
   * backdrop. Resolves with the mesh count and a disposer that removes it (so a new
   * backdrop can replace it). Babylon-only for now.
   */
  loadBackdrop?(source: string | File): Promise<{ meshCount: number; dispose(): void }>;
  /** Draw an in-scene heatmap overlay for a scene id; returns a disposer. */
  showHeatmap?(sceneId: string): Promise<{ dispose(): void }>;
  /** Scan + register a scene proxy; resolves with the mesh count. */
  registerSceneProxy?(sceneId: string): Promise<number>;
  /** Tear down the scene + connector. */
  dispose(): void;
}

/** The shape each `src/engines/<id>.ts` module exports as `engine`. */
export interface EngineModule {
  readonly id: EngineId;
  readonly label: string;
  readonly captureFeatures: CaptureFeature[];
  readonly capabilities: EngineCapabilities;
  mount(ctx: EngineMountContext): Promise<EngineInstance>;
}

/** Capture features shared by the WebGL connectors (three/playcanvas). */
export const COMMON_CAPTURE_FEATURES: CaptureFeature[] = [
  { key: "camera", label: "Camera pose", default: true },
  { key: "pointerMove", label: "Pointer move", default: true },
  { key: "clicks", label: "Clicks", default: true },
  { key: "buttons", label: "Button down/up", default: true },
  { key: "meshPicks", label: "Mesh picks", default: true },
  { key: "perf", label: "Frame perf", default: true },
  { key: "contextLoss", label: "Context loss", default: true },
  { key: "meshVisibility", label: "Mesh visibility", default: true },
  { key: "hoverDwell", label: "Hover dwell", default: true },
  { key: "resourceSample", label: "Resource sample", default: true },
  // World-space gaze raycast (`camera_sample.hitPoint`, ADR 0030) powers the gaze
  // heatmap. The SDK keeps this opt-in (privacy + cost, ADR 0003 / ADR 0012); the
  // playground enables it so every 3D panel renders out of the box.
  { key: "gaze", label: "Gaze raycast", default: true },
];

/** Demo scene box colors (shared so every engine renders the same five boxes). */
export const BOX_COLORS: readonly [number, number, number][] = [
  [0.9, 0.3, 0.3],
  [0.3, 0.7, 0.9],
  [0.4, 0.85, 0.5],
  [0.95, 0.8, 0.3],
  [0.7, 0.45, 0.9],
];
