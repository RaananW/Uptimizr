import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { LIMITS } from "../limits.js";
import { graphicsApiSchema } from "./sessionStart.js";

/**
 * How serious an engine diagnostic is. Mirrors the usual log levels so consumers
 * can threshold (e.g. alert on `error`/`fatal`, ignore `info`):
 *
 * - `info`    — benign/observational (e.g. a recoverable, expected device loss).
 * - `warning` — non-fatal but worth surfacing (e.g. a validation warning).
 * - `error`   — something failed but the session continues (e.g. a shader compile
 *   failure, a captured `GPUError`).
 * - `fatal`   — rendering cannot continue (e.g. unrequested device loss, no usable
 *   context could be created).
 */
export const graphicsDiagnosticSeveritySchema = z.enum(["info", "warning", "error", "fatal"]);
export type GraphicsDiagnosticSeverity = z.infer<typeof graphicsDiagnosticSeveritySchema>;

/**
 * What *class* of engine diagnostic this is. Engine-agnostic so every connector
 * maps its backend-specific callbacks onto the same small set:
 *
 * - `context-loss`   — the rendering context was lost or could not be created.
 * - `validation`     — an API validation error (e.g. WebGPU `uncapturederror` of
 *   the validation kind, a sampled WebGL `gl.getError()`).
 * - `out-of-memory`  — a GPU/host out-of-memory error.
 * - `shader-compile` — a shader/pipeline compile or link **failure** (timing lives
 *   in the separate `compile_stall` event).
 * - `device-lost`    — a WebGPU `GPUDevice.lost` event.
 * - `fallback`       — reserved for forward-compatibility. **Not emitted by any
 *   connector** (ADR 0021 decision 2: engine-driven backend fallback stays in the
 *   app-reported `capability_change` event). Kept in the enum so the contract is
 *   stable if that ever changes.
 */
export const graphicsDiagnosticCategorySchema = z.enum([
  "context-loss",
  "validation",
  "out-of-memory",
  "shader-compile",
  "device-lost",
  "fallback",
]);
export type GraphicsDiagnosticCategory = z.infer<typeof graphicsDiagnosticCategorySchema>;

/**
 * Opt-in engine diagnostic — a GPU-health signal authored by the rendering engine
 * (ADR 0021 part 2). A single engine-agnostic event class with a uniform shape
 * across backends, covering GPU errors/warnings, shader-compile failures, richer
 * context-loss reasons, WebGPU `uncapturederror`, and sampled `gl.getError()`.
 *
 * **Off by default.** Capture is gated by the `captureGraphicsDiagnostics` flag in
 * the SDK (mirroring JS error capture, ADR 0013); only `context_lost` /
 * `context_restored` are exempt and stay always-on. Free text (`message`/`code`)
 * is length-capped and passes through `beforeSend` for deployer-owned redaction;
 * raw shader source is a separate sub-opt-in and is never embedded here by default.
 *
 * **Rollup-or-marker (ADR 0021 decision 4).** One event type carries *either* a
 * single discrete incident *or* an aggregated per-session rollup. `count` is the
 * discriminator: omit it for a discrete ordered marker; set it to aggregate `count`
 * incidents into one event (with `message`/`code` describing the first/representative
 * incident). The rollup is the cheap default so an error storm cannot flood
 * ingestion (ADR 0012); discrete markers are the high-fidelity opt-in.
 */
export const graphicsDiagnosticSchema = defineEvent("graphics_diagnostic", {
  /** How serious the diagnostic is. */
  severity: graphicsDiagnosticSeveritySchema,
  /** What class of diagnostic this is. */
  category: graphicsDiagnosticCategorySchema,
  /**
   * Which rendering API produced the diagnostic (best-effort). Reuses the
   * always-on `graphics.api` enum so the WebGPU vs WebGL split is consistent.
   */
  backend: graphicsApiSchema.optional(),
  /**
   * Optional human-readable message (engine/driver/shader error text). Length-
   * capped; redact via `beforeSend`. Never carries raw shader source by default.
   */
  message: z.string().max(LIMITS.maxGraphicsDiagnosticMessageLength).optional(),
  /** Optional short code (e.g. GL error constant, `GPUError` subtype). */
  code: z.string().max(LIMITS.maxGraphicsDiagnosticCodeLength).optional(),
  /**
   * Rollup discriminator. Omit for a single discrete incident marker; set to a
   * positive integer to aggregate that many incidents into one rollup event
   * (`message`/`code` then describe the first/representative incident).
   */
  count: z.number().int().positive().optional(),
});
export type GraphicsDiagnosticEvent = z.infer<typeof graphicsDiagnosticSchema>;
