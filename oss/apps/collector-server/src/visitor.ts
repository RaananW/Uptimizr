import { createHash } from "node:crypto";

/**
 * Derive the per-day salt from the server secret. Rotating the salt daily means a
 * visitor hash cannot be correlated across days — the cornerstone of the
 * cookieless, no-persistent-ID privacy model (ADR 0003).
 */
export function dailySalt(secret: string, date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return createHash("sha256").update(`${secret}:${day}`).digest("hex");
}

/**
 * Compute the cookieless visitor id as `hash(ip + ua + dailySalt)`. The raw IP is
 * never stored — only this derived, daily-rotating hash leaves the server.
 */
export function visitorHash(ip: string, ua: string, salt: string): string {
  return createHash("sha256").update(`${ip}|${ua}|${salt}`).digest("hex").slice(0, 32);
}
