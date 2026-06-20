import { z } from "zod";
import { defineEvent } from "./defineEvent.js";

/** Which browser channel produced the error. */
export const runtimeErrorKindSchema = z.enum(["error", "unhandledrejection"]);
export type RuntimeErrorKind = z.infer<typeof runtimeErrorKindSchema>;

/**
 * A JavaScript error or unhandled promise rejection caught on the page
 * (`window.onerror` / `unhandledrejection`). Opt-in — error text can carry PII,
 * so capture is off by default and redaction is the deployer's responsibility
 * via the `beforeSend` hook (ADR 0013). Free-text fields are length-capped.
 */
export const runtimeErrorSchema = defineEvent("runtime_error", {
  /** Source channel: a thrown error vs. an unhandled rejection. */
  kind: runtimeErrorKindSchema,
  /** Error message (truncated). */
  message: z.string().max(1024),
  /** Script URL where the error originated, if known (truncated). */
  source: z.string().max(1024).optional(),
  /** 1-based line number, if known. */
  lineno: z.number().int().nonnegative().optional(),
  /** 1-based column number, if known. */
  colno: z.number().int().nonnegative().optional(),
  /** Stack trace (truncated). */
  stack: z.string().max(4096).optional(),
});
export type RuntimeErrorEvent = z.infer<typeof runtimeErrorSchema>;
