import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { coordinateSystemSchema } from "../coordinateSystem.js";
import { LIMITS, boundedRecord } from "../limits.js";

/**
 * Rendering engine / GPU capabilities, captured once per session.
 *
 * Covers both WebGL2 and WebGPU (Babylon's `engine.getCaps()`), normalized into a
 * single block. Fields are optional and `passthrough`-friendly so new capability
 * hints can be added without a breaking change.
 */
export const deviceSchema = z
  .object({
    /** Graphics backend in use. */
    engine: z.enum(["webgl2", "webgpu", "webgl", "unknown"]).optional(),
    /** Unmasked GPU vendor string, when exposed. */
    vendor: z.string().optional(),
    /** Unmasked GPU renderer string, when exposed. */
    renderer: z.string().optional(),
    /** Maximum texture size supported. */
    maxTextureSize: z.number().optional(),
    /** Hardware concurrency (logical CPU cores), when exposed. */
    hardwareConcurrency: z.number().optional(),
    /** Approximate device memory in GB, when exposed. */
    deviceMemoryGb: z.number().optional(),
    /** Whether the context reports as a mobile device. */
    isMobile: z.boolean().optional(),
    /**
     * Coarse browser family, derived **server-side** from the request User-Agent at
     * ingestion (e.g. `"Chrome"`, `"Safari"`, `"Firefox"`, `"Edge"`, `"Other"`).
     * Low-cardinality, non-PII, never the raw UA or a version (ADR 0003 / ADR 0041).
     * The collector overrides any client-supplied value, so it is authoritative.
     */
    browser: z.string().optional(),
    /**
     * Coarse operating-system family, derived **server-side** from the request
     * User-Agent at ingestion (e.g. `"Windows"`, `"macOS"`, `"iOS"`, `"Android"`,
     * `"Linux"`, `"Other"`). Low-cardinality, non-PII, never the raw UA or a
     * version (ADR 0003 / ADR 0041). The collector overrides any client value.
     */
    os: z.string().optional(),
  })
  .passthrough();
export type Device = z.infer<typeof deviceSchema>;

/**
 * How the scene's primary camera is driven. Helps segment sessions by navigation
 * model (e.g. orbit vs. free-fly vs. on-rails) when interpreting heatmaps.
 *
 * - `arc-rotate` — orbits a target (Babylon `ArcRotateCamera`).
 * - `free` — free-fly / first-person (`FreeCamera`, `UniversalCamera`).
 * - `follow` — tracks a moving object (`FollowCamera`).
 * - `static` — fixed, not user-controlled.
 * - `other` — anything else / unknown.
 */
export const cameraKindSchema = z.enum(["arc-rotate", "free", "follow", "static", "other"]);
export type CameraKind = z.infer<typeof cameraKindSchema>;

/**
 * Optional, coarse description of the 3D scene, captured once per session. Lets
 * consumers give context to a session without inspecting individual events. All
 * fields are optional and `passthrough`-friendly so adapters can add hints.
 */
export const sceneMetaSchema = z
  .object({
    /** Free-text label for the scene/experience, e.g. `"product-configurator"`. */
    description: z.string().max(LIMITS.maxSceneDescriptionLength).optional(),
    /** How the active camera is driven. */
    cameraType: cameraKindSchema.optional(),
    /** Active camera's name, e.g. `"mainCamera"`. */
    cameraName: z.string().max(LIMITS.maxCameraNameLength).optional(),
    /** Number of meshes in the scene at session start. */
    meshCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type SceneMeta = z.infer<typeof sceneMetaSchema>;

/** Value types allowed for caller-supplied user traits. */
export const userTraitValueSchema = z.union([
  z.string().max(LIMITS.maxUserTraitValueLength),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type UserTraitValue = z.infer<typeof userTraitValueSchema>;

/**
 * Optional, caller-supplied user context. Opt-in only.
 *
 * Privacy: Uptimizr never derives this. The framework user passes it explicitly
 * and is responsible for anonymizing it — `id` MUST NOT be PII (use a pseudonymous
 * or hashed identifier). Omit it entirely to stay fully anonymous (ADR 0003).
 */
export const sessionUserSchema = z
  .object({
    /** Anonymized/pseudonymous identifier supplied by the host app. Never PII. */
    id: z.string().max(LIMITS.maxUserIdLength).optional(),
    /** Arbitrary, non-identifying traits for segmentation (bounded count + value size). */
    traits: boundedRecord(userTraitValueSchema, LIMITS.maxUserTraitEntries).optional(),
  })
  .passthrough();
export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * Identifies the connector (3D-engine adapter) that produced the session and the
 * source engine's **native** world coordinate frame (ADR 0018). Captured once per
 * session as provenance.
 *
 * Important: world-space payloads on the wire are always in the canonical frame
 * (left-handed, y-up, unit scale 1). `coordinateSystem` records what the *source*
 * frame was — not the frame the data is in. Connectors whose engine differs from
 * canonical normalize at the emission boundary and record their native frame here.
 *
 * `passthrough`-friendly so adapters can add hints without a breaking change.
 */
export const connectorSchema = z
  .object({
    /** Connector / engine id, e.g. `"babylon"`, `"three"`, `"playcanvas"`. */
    name: z.string(),
    /** Underlying engine library version (e.g. Babylon.js / three.js revision), if known. */
    version: z.string().optional(),
    /** The source engine's native world coordinate frame. */
    coordinateSystem: coordinateSystemSchema.optional(),
  })
  .passthrough();
export type Connector = z.infer<typeof connectorSchema>;

/**
 * The rendering API surface a session runs on (ADR 0021). Covers both web
 * (`webgl`/`webgl2`/`webgpu`) and native (`opengl`/`opengles`/`d3d11`/`d3d12`/
 * `vulkan`/`metal`) engines so every connector can report it uniformly.
 */
export const graphicsApiSchema = z.enum([
  "webgl",
  "webgl2",
  "webgpu",
  "opengl",
  "opengles",
  "d3d11",
  "d3d12",
  "vulkan",
  "metal",
  "unknown",
]);
export type GraphicsApi = z.infer<typeof graphicsApiSchema>;

/**
 * The real backend behind an abstraction, when discoverable. A WebGPU context,
 * for example, is backed by Metal, D3D12, or Vulkan depending on the platform.
 */
export const graphicsBackendSchema = z.enum([
  "metal",
  "d3d11",
  "d3d12",
  "vulkan",
  "opengl",
  "opengles",
  "unknown",
]);
export type GraphicsBackend = z.infer<typeof graphicsBackendSchema>;

/** Shading language the engine compiles, when known. */
export const shadingLanguageSchema = z.enum([
  "glsl",
  "glsl-es",
  "wgsl",
  "hlsl",
  "msl",
  "spirv",
  "unknown",
]);
export type ShadingLanguage = z.infer<typeof shadingLanguageSchema>;

/**
 * The underlying graphics technology a session renders with (ADR 0021), captured
 * once per session as always-on, non-PII, low-cardinality metadata. Generalizes
 * the coarse `device.engine` field: it distinguishes the API *surface*
 * (`api`) from the real backend beneath it (`backend`), and records the API
 * version and shading language when exposed.
 *
 * All fields are optional and best-effort — on the web, `backend` and version are
 * heuristic (WebGPU adapter info / unmasked renderer) and may be `unknown` when
 * the browser withholds them. `passthrough`-friendly so connectors can add hints.
 */
export const graphicsSchema = z
  .object({
    /** Rendering API surface in use. */
    api: graphicsApiSchema.optional(),
    /** Real backend behind the API, when discoverable (e.g. WebGPU → `metal`). */
    backend: graphicsBackendSchema.optional(),
    /** API/driver version string when exposed (e.g. GL version, WebGPU feature level). */
    apiVersion: z.string().optional(),
    /** Shading language the engine compiles. */
    shadingLanguage: shadingLanguageSchema.optional(),
  })
  .passthrough();
export type Graphics = z.infer<typeof graphicsSchema>;

/**
 * Emitted once at the beginning of a session. Carries the device/GPU block plus
 * optional scene and caller-supplied user metadata, stored as the session's
 * descriptor.
 */
export const sessionStartSchema = defineEvent("session_start", {
  device: deviceSchema.optional(),
  graphics: graphicsSchema.optional(),
  scene: sceneMetaSchema.optional(),
  user: sessionUserSchema.optional(),
  connector: connectorSchema.optional(),
});
export type SessionStartEvent = z.infer<typeof sessionStartSchema>;
