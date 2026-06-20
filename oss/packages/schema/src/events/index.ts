import { z } from "zod";

import { sessionStartSchema } from "./sessionStart.js";
import { sessionEndSchema } from "./sessionEnd.js";
import { framePerfSchema } from "./framePerf.js";
import { cameraSampleSchema } from "./cameraSample.js";
import { nodeTransformSchema } from "./nodeTransform.js";
import { pointerMoveSchema } from "./pointerMove.js";
import { pointerClickSchema } from "./pointerClick.js";
import { pointerDownSchema, pointerUpSchema } from "./pointerButton.js";
import { cameraGestureSchema } from "./cameraGesture.js";
import { meshInteractionSchema } from "./meshInteraction.js";
import { meshVisibilitySchema } from "./meshVisibility.js";
import { hoverDwellSchema } from "./hoverDwell.js";
import { compileStallSchema } from "./compileStall.js";
import { resourceSampleSchema } from "./resourceSample.js";
import { capabilityChangeSchema } from "./capabilityChange.js";
import { assetLoadSchema } from "./assetLoad.js";
import { sceneChangeSchema } from "./sceneChange.js";
import { viewportResizeSchema } from "./viewportResize.js";
import { visibilityChangeSchema } from "./visibilityChange.js";
import { focusChangeSchema } from "./focusChange.js";
import { contextLostSchema, contextRestoredSchema } from "./contextLoss.js";
import { runtimeErrorSchema } from "./runtimeError.js";
import { inputActionSchema } from "./inputAction.js";
import { customSchema } from "./custom.js";

/**
 * Central event registry.
 *
 * ## Adding a new event type (the extension point)
 * 1. Create `events/myEvent.ts` using `defineEvent("my_event", { ...payload })`.
 * 2. Import it here and add it to `eventSchemaList` below.
 * 3. Add its literal to `EVENT_TYPES` in `constants.ts`.
 *
 * The discriminated union, the `EventSchemaByType` map, and every exhaustiveness
 * check downstream update automatically from this single list.
 */
export const eventSchemaList = [
  sessionStartSchema,
  sessionEndSchema,
  framePerfSchema,
  cameraSampleSchema,
  nodeTransformSchema,
  pointerMoveSchema,
  pointerClickSchema,
  pointerDownSchema,
  pointerUpSchema,
  cameraGestureSchema,
  meshInteractionSchema,
  meshVisibilitySchema,
  hoverDwellSchema,
  compileStallSchema,
  resourceSampleSchema,
  capabilityChangeSchema,
  assetLoadSchema,
  sceneChangeSchema,
  viewportResizeSchema,
  visibilityChangeSchema,
  focusChangeSchema,
  contextLostSchema,
  contextRestoredSchema,
  runtimeErrorSchema,
  inputActionSchema,
  customSchema,
] as const;

/**
 * Discriminated union of all events, keyed on `type`. Use this to validate a
 * single event of unknown type.
 */
export const anyEventSchema = z.discriminatedUnion("type", [
  sessionStartSchema,
  sessionEndSchema,
  framePerfSchema,
  cameraSampleSchema,
  nodeTransformSchema,
  pointerMoveSchema,
  pointerClickSchema,
  pointerDownSchema,
  pointerUpSchema,
  cameraGestureSchema,
  meshInteractionSchema,
  meshVisibilitySchema,
  hoverDwellSchema,
  compileStallSchema,
  resourceSampleSchema,
  capabilityChangeSchema,
  assetLoadSchema,
  sceneChangeSchema,
  viewportResizeSchema,
  visibilityChangeSchema,
  focusChangeSchema,
  contextLostSchema,
  contextRestoredSchema,
  runtimeErrorSchema,
  inputActionSchema,
  customSchema,
]);

/** Any built-in event, as a discriminated union type. */
export type AnyEvent = z.infer<typeof anyEventSchema>;

/**
 * Lookup map from event `type` to its schema. Handy for per-type validation,
 * storage routing, and tests.
 */
export const eventSchemaByType = {
  session_start: sessionStartSchema,
  session_end: sessionEndSchema,
  frame_perf: framePerfSchema,
  camera_sample: cameraSampleSchema,
  node_transform: nodeTransformSchema,
  pointer_move: pointerMoveSchema,
  pointer_click: pointerClickSchema,
  pointer_down: pointerDownSchema,
  pointer_up: pointerUpSchema,
  camera_gesture: cameraGestureSchema,
  mesh_interaction: meshInteractionSchema,
  mesh_visibility: meshVisibilitySchema,
  hover_dwell: hoverDwellSchema,
  compile_stall: compileStallSchema,
  resource_sample: resourceSampleSchema,
  capability_change: capabilityChangeSchema,
  asset_load: assetLoadSchema,
  scene_change: sceneChangeSchema,
  viewport_resize: viewportResizeSchema,
  visibility_change: visibilityChangeSchema,
  focus_change: focusChangeSchema,
  context_lost: contextLostSchema,
  context_restored: contextRestoredSchema,
  runtime_error: runtimeErrorSchema,
  input_action: inputActionSchema,
  custom: customSchema,
} as const;

// Per-event schema and type re-exports.
export {
  sessionStartSchema,
  deviceSchema,
  sceneMetaSchema,
  cameraKindSchema,
  sessionUserSchema,
  userTraitValueSchema,
  connectorSchema,
  graphicsApiSchema,
  graphicsBackendSchema,
  shadingLanguageSchema,
  graphicsSchema,
  type SessionStartEvent,
  type Device,
  type SceneMeta,
  type CameraKind,
  type SessionUser,
  type UserTraitValue,
  type Connector,
  type GraphicsApi,
  type GraphicsBackend,
  type ShadingLanguage,
  type Graphics,
} from "./sessionStart.js";
export { sessionEndSchema, type SessionEndEvent } from "./sessionEnd.js";
export { framePerfSchema, type FramePerfEvent } from "./framePerf.js";
export { cameraSampleSchema, type CameraSampleEvent } from "./cameraSample.js";
export { nodeTransformSchema, type NodeTransformEvent } from "./nodeTransform.js";
export { pointerMoveSchema, type PointerMoveEvent } from "./pointerMove.js";
export { pointerClickSchema, type PointerClickEvent } from "./pointerClick.js";
export {
  pointerDownSchema,
  pointerUpSchema,
  type PointerDownEvent,
  type PointerUpEvent,
} from "./pointerButton.js";
export {
  cameraGestureSchema,
  cameraGestureKindSchema,
  type CameraGestureEvent,
  type CameraGestureKind,
} from "./cameraGesture.js";
export {
  meshInteractionSchema,
  meshInteractionKindSchema,
  type MeshInteractionEvent,
  type MeshInteractionKind,
} from "./meshInteraction.js";
export { meshVisibilitySchema, type MeshVisibilityEvent } from "./meshVisibility.js";
export { hoverDwellSchema, type HoverDwellEvent } from "./hoverDwell.js";
export {
  compileStallSchema,
  compileStallPhaseSchema,
  type CompileStallEvent,
  type CompileStallPhase,
} from "./compileStall.js";
export { resourceSampleSchema, type ResourceSampleEvent } from "./resourceSample.js";
export {
  capabilityChangeSchema,
  capabilityChangeKindSchema,
  type CapabilityChangeEvent,
  type CapabilityChangeKind,
} from "./capabilityChange.js";
export { assetLoadSchema, type AssetLoadEvent } from "./assetLoad.js";
export { sceneChangeSchema, type SceneChangeEvent } from "./sceneChange.js";
export { viewportResizeSchema, type ViewportResizeEvent } from "./viewportResize.js";
export {
  visibilityChangeSchema,
  visibilityStateSchema,
  type VisibilityChangeEvent,
  type VisibilityState,
} from "./visibilityChange.js";
export { focusChangeSchema, type FocusChangeEvent } from "./focusChange.js";
export {
  contextLostSchema,
  contextRestoredSchema,
  type ContextLostEvent,
  type ContextRestoredEvent,
} from "./contextLoss.js";
export {
  runtimeErrorSchema,
  runtimeErrorKindSchema,
  type RuntimeErrorEvent,
  type RuntimeErrorKind,
} from "./runtimeError.js";
export {
  inputSourceSchema,
  handednessSchema,
  raySchema,
  inputSourceShape,
  type InputSource,
  type Handedness,
  type Ray,
} from "./inputSource.js";
export { inputActionSchema, type InputActionEvent } from "./inputAction.js";
export {
  customSchema,
  customPropValueSchema,
  type CustomEvent,
  type CustomPropValue,
} from "./custom.js";
export { defineEvent } from "./defineEvent.js";
