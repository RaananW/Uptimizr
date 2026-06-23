import { track } from "@vercel/analytics";

/**
 * Demo-level usage analytics.
 *
 * These events describe how visitors interact with the *demo shell itself*
 * (preparing the in-browser store, resetting data, switching scenes). They are
 * emitted from the top frame only — the embedded playground and dashboard
 * iframes are untouched, so no Uptimizr/Babylon internals leak into Vercel.
 *
 * Custom events are no-ops outside a Vercel deployment, so local dev and tests
 * are unaffected.
 */

/** Visitor clicked "Prepare demo" and the asset/database bootstrap began. */
export function trackPrepareStarted(): void {
  track("demo_prepare_started");
}

/** The in-browser store finished bootstrapping and the live split view opened. */
export function trackPrepareReady(): void {
  track("demo_prepare_ready");
}

/** Bootstrap failed. The message is truncated so no large payloads are sent. */
export function trackPrepareError(message: string): void {
  track("demo_prepare_error", { message: message.slice(0, 200) });
}

/** Visitor cleared the collected analytics via "Clear data". */
export function trackReset(): void {
  track("demo_reset");
}

/** The embedded playground switched scene/engine (announced via postMessage). */
export function trackSceneChanged(sceneId: string, engineId: string): void {
  track("demo_scene_changed", { sceneId, engineId });
}
