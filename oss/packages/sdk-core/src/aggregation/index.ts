/**
 * Connector-side offload aggregation (ADR 0031 follow-up, #10).
 *
 * The {@link Aggregator} owns the offload-eligible *processing* phase of
 * per-frame capture; connectors feed it plain-number {@link Snapshot} DTOs. The
 * pure math is exported too so it has a single, shared home (no per-engine fork).
 */
export { createAggregator } from "./aggregator.js";
export type { Aggregator, AggregatorConfig, AggregatorOptions } from "./aggregator.js";
export { collectSnapshotTransferables } from "./snapshot.js";
export type {
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
} from "./snapshot.js";
export {
  percentileAsc,
  visibilityContribution,
  aabbClose,
  roundAabb,
  vec3Close,
  poseUnchanged,
  nodeSampleUnchanged,
  clamp01,
  sub3,
  dot3,
  length3,
} from "./math.js";
export type { VisibilityContribution, CameraPose, NodeSample } from "./math.js";
