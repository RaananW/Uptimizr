/**
 * `@uptimizr/schema` — the single source of truth for Uptimizr analytics events.
 *
 * Every producer (SDKs) and consumer (collector, replay, dashboard) imports event
 * shapes from here. Never redefine event types elsewhere.
 *
 * See the package README for the event catalog and how to add new event types.
 */

export { SCHEMA_VERSION, DEFAULT_SCENE_ID, EVENT_TYPES, type EventType } from "./constants.js";

export { LIMITS, boundedRecord } from "./limits.js";

export {
  vec3Schema,
  vec2Schema,
  quatSchema,
  normalized2Schema,
  epochMsSchema,
  sceneIdSchema,
  type Vec3,
  type Vec2,
  type Quat,
  type Normalized2,
  type SceneId,
} from "./primitives.js";

export {
  envelopeSchema,
  envelopeShape,
  pageMetaSchema,
  type Envelope,
  type PageMeta,
} from "./envelope.js";

export {
  // registry + union
  eventSchemaList,
  anyEventSchema,
  eventSchemaByType,
  type AnyEvent,
  // factory
  defineEvent,
  // per-event schemas + types
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
  sessionEndSchema,
  framePerfSchema,
  cameraSampleSchema,
  nodeTransformSchema,
  pointerMoveSchema,
  pointerClickSchema,
  pointerDownSchema,
  pointerUpSchema,
  cameraGestureSchema,
  cameraGestureKindSchema,
  meshInteractionSchema,
  meshInteractionKindSchema,
  assetLoadSchema,
  sceneChangeSchema,
  inputSourceSchema,
  handednessSchema,
  raySchema,
  inputSourceShape,
  inputActionSchema,
  customSchema,
  customPropValueSchema,
  capabilityChangeSchema,
  capabilityChangeKindSchema,
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
  type SessionStartEvent,
  type SessionEndEvent,
  type FramePerfEvent,
  type CameraSampleEvent,
  type NodeTransformEvent,
  type PointerMoveEvent,
  type PointerClickEvent,
  type PointerDownEvent,
  type PointerUpEvent,
  type CameraGestureEvent,
  type CameraGestureKind,
  type MeshInteractionEvent,
  type MeshInteractionKind,
  type AssetLoadEvent,
  type SceneChangeEvent,
  type InputSource,
  type Handedness,
  type Ray,
  type InputActionEvent,
  type CustomEvent,
  type CustomPropValue,
  type CapabilityChangeEvent,
  type CapabilityChangeKind,
} from "./events/index.js";

export {
  collectRequestSchema,
  collectResponseSchema,
  type CollectRequest,
  type CollectResponse,
} from "./batch.js";

export {
  SCENE_PROXY_VERSION,
  aabbSchema,
  upAxisSchema,
  sceneProxyKindSchema,
  meshTransformSchema,
  sceneProxyMeshSchema,
  sceneProxySchema,
  type Aabb,
  type UpAxis,
  type SceneProxyKind,
  type MeshTransform,
  type SceneProxyMesh,
  type SceneProxy,
} from "./sceneProxy.js";

export {
  coordinateHandednessSchema,
  coordinateSystemSchema,
  type CoordinateHandedness,
  type CoordinateSystem,
} from "./coordinateSystem.js";
