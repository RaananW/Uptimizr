/**
 * Privacy model (ADR 0003), browser edition. The collector derives a visitor id
 * from a daily-rotating server-side salt so the same person is countable within
 * a day but not trackable across days, and never with a client-persistent id.
 *
 * In the backend-less demo there is no server, so we reproduce the same scheme
 * entirely in-page with WebCrypto: a per-session random secret seeds a
 * day-stamped salt, and the visitor id is a truncated SHA-256 of
 * `pseudoIp|userAgent|salt`. The "ip" is a stable random token for this tab
 * (no real IP is available or wanted in the browser). Everything is ephemeral
 * and dies with the page.
 */

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Today's UTC date stamp (`YYYY-MM-DD`) used to rotate the salt daily. */
function utcDayStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Per-page random secret — the demo's stand-in for the server's salt secret. */
const SESSION_SECRET = crypto.randomUUID();

/** Per-page random "pseudo IP" — a stable token so a tab counts as one visitor. */
const PSEUDO_IP = crypto.randomUUID();

/**
 * Compute the daily-rotating visitor id for this page. Truncated to 32 hex chars
 * to match the collector's stored `visitor_id` width.
 */
export async function visitorHash(userAgent: string, now = new Date()): Promise<string> {
  const salt = await sha256Hex(`${SESSION_SECRET}:${utcDayStamp(now)}`);
  const full = await sha256Hex(`${PSEUDO_IP}|${userAgent}|${salt}`);
  return full.slice(0, 32);
}
