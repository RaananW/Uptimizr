/**
 * Demo-wide constants. The in-browser demo is single-tenant and public, so the
 * project id and read key are fixed, well-known values — there is no secret to
 * protect (nothing leaves the browser).
 */

/** The one project every demo event is written to and every query reads from. */
export const DEMO_PROJECT_ID = "demo";

/** The read key the embedded dashboard presents; accepted unconditionally. */
export const DEMO_API_KEY = "demo-read-key";

/** Friendly project name shown by the dashboard. */
export const DEMO_PROJECT_NAME = "Uptimizr Demo";

/**
 * Rolling retention bound (events). The demo must never grow without limit and
 * burden the device, so the store trims to the most recent N rows after each
 * ingest batch. Generous enough for a rich session, small enough to stay light.
 */
export const MAX_RETAINED_EVENTS = 200_000;

/** Same rolling bound for the high-cardinality `node_transform` samples table. */
export const MAX_RETAINED_NODE_SAMPLES = 200_000;
