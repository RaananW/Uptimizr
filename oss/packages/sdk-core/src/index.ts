/**
 * `@uptimizr/sdk-core` — the framework-agnostic Uptimizr capture runtime.
 *
 * Owns the session, an in-memory batching queue, flush scheduling, and a cookieless
 * transport. Engine-specific capture (e.g. Babylon) plugs in via `client.use()`.
 */

export { UptimizrClient } from "./client.js";
export { EventQueue } from "./queue.js";
export { createBeaconTransport } from "./transport.js";
export { createMainProcessor, createWorkerProcessor, collectTransferables } from "./processor.js";
export { randomId } from "./idgen.js";
export { SDK_VERSION } from "./version.js";
export { resolveCadence } from "./sampling.js";
export { classifyCameraGesture, DEFAULT_GESTURE_THRESHOLDS } from "./gesture.js";
export {
  CANONICAL_FRAME,
  toCanonicalAabb,
  toCanonicalDirection,
  toCanonicalPosition,
  toCanonicalQuat,
  fromCanonicalAabb,
  fromCanonicalDirection,
  fromCanonicalPosition,
  fromCanonicalQuat,
} from "./coordinates.js";
export { decomposeWorldMatrix } from "./matrix.js";
export type { DecomposedTransform } from "./matrix.js";
export {
  createAggregator,
  collectSnapshotTransferables,
  percentileAsc,
  visibilityContribution,
  aabbClose,
  roundAabb,
  vec3Close,
  poseUnchanged,
  nodeSampleUnchanged,
  clamp01,
} from "./aggregation/index.js";
export type {
  Aggregator,
  AggregatorConfig,
  AggregatorOptions,
  Snapshot,
  SnapshotChannel,
  CameraSnapshot,
  PerfSnapshot,
  NodeSnapshot,
  VisibilityMeshObservation,
  VisibilityTickSnapshot,
  VisibilityFlushSnapshot,
  GestureSnapshot,
  HoverSnapshot,
  VisibilityContribution,
  CameraPose,
  NodeSample,
} from "./aggregation/index.js";
export { xrSource, xrHandedness } from "./xrInput.js";
export { wireGpuDeviceLost } from "./graphicsDiagnostics.js";
export type { GpuDeviceLostLike, GpuDeviceLostInfoLike } from "./graphicsDiagnostics.js";

export type {
  Collector,
  CollectorContext,
  CollectorHandle,
  BeforeSendHook,
  EventInput,
  ResolvedConfig,
  StartMeta,
  TrackInputOptions,
  CapabilityChangeReport,
  Transport,
  UptimizrConfig,
} from "./types.js";

export type { Processor, WorkerLike, WorkerFactory, WorkerProcessorOptions } from "./processor.js";
export { createMainSink, createWorkerAggregationSink } from "./aggregationSink.js";
export type { AggregationSink, WorkerAggregationSinkOptions } from "./aggregationSink.js";

export type {
  SampleRate,
  SamplingProfile,
  BoneSamplingConfig,
  NodeSamplingConfig,
  ResolvedCadence,
} from "./sampling.js";
export type {
  CameraGestureSample,
  ClassifiedGesture,
  GestureThresholds,
  GestureClassifyOptions,
} from "./gesture.js";
export type { XrInputSourceLike, XrCaptureOptions, XrRayHit, XrRayProbe } from "./xrInput.js";
