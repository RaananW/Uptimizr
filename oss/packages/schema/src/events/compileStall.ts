import { z } from "zod";
import { defineEvent } from "./defineEvent.js";

/**
 * Coarse classification of *what* was being compiled when the main thread
 * stalled. Engines surface compilation at different granularities, so this stays
 * deliberately small and best-effort:
 *
 * - `shader`   — a single shader / effect program (Babylon's
 *   `onBeforeShaderCompilationObservable` span; the common case).
 * - `pipeline` — a full render pipeline / PSO (WebGPU pipeline creation).
 * - `material` — a material's program(s) compiled on first use.
 * - `other`    — anything the connector cannot attribute precisely.
 *
 * The field is optional: a connector that cannot distinguish phases omits it.
 */
export const compileStallPhaseSchema = z.enum(["shader", "pipeline", "material", "other"]);

export type CompileStallPhase = z.infer<typeof compileStallPhaseSchema>;

/**
 * Shader / pipeline compilation hitch (#42, design §C). Pipeline and shader
 * compilation is the #1 source of first-interaction hitches on WebGPU/WebGL:
 * `frame_perf` averages the pain away, so a discrete `compile_stall` captures the
 * main-thread time spent compiling — the spikes users actually feel.
 *
 * The connector measures the *main-thread* compilation span (e.g. Babylon's
 * `onBeforeShaderCompilationObservable` → `onAfterShaderCompilationObservable`)
 * and emits one event per compile. Compilation is a bounded, mostly first-load
 * cost, so this is on by default (design §C) rather than sampled.
 *
 * Privacy (ADR 0003): carries only a duration and a coarse phase label — no PII,
 * no scene contents, no per-frame trace.
 */
export const compileStallSchema = defineEvent("compile_stall", {
  /** Main-thread milliseconds spent compiling (the felt stall). */
  durationMs: z.number().nonnegative(),
  /** Coarse classification of what was compiled, when the connector can tell. */
  phase: compileStallPhaseSchema.optional(),
});

export type CompileStallEvent = z.infer<typeof compileStallSchema>;
