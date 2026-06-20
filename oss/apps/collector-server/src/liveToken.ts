import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived, project-scoped signed tokens for the live SSE endpoints
 * (ADR 0032 §7). `EventSource` cannot send an `Authorization`/`x-api-key`
 * header, so the dashboard's server exchanges its API key for one of these
 * tokens (`POST /api/v1/live/token`) and the browser passes it as `?token=`.
 * The raw API key never appears in a URL.
 *
 * The token is an HMAC over `{projectId, expiry}` keyed by a server secret, so
 * verification needs no shared state and no lookup. It is intentionally opaque
 * and carries no PII.
 */

interface TokenPayload {
  /** Project the token authorizes. */
  p: string;
  /** Expiry in epoch ms. */
  e: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** Mint a token authorizing `projectId` until `now + ttlMs`. */
export function mintLiveToken(
  projectId: string,
  secret: string,
  ttlMs: number,
  now: number = Date.now(),
): { token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  const payload: TokenPayload = { p: projectId, e: expiresAt };
  const payloadB64 = b64url(JSON.stringify(payload));
  const token = `${payloadB64}.${sign(payloadB64, secret)}`;
  return { token, expiresAt };
}

/**
 * Verify a token and return its project id, or `null` if malformed, tampered,
 * or expired. Uses a constant-time signature comparison.
 */
export function verifyLiveToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(payloadB64, secret);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.p !== "string" || typeof payload.e !== "number") return null;
  if (now >= payload.e) return null;
  return payload.p;
}
