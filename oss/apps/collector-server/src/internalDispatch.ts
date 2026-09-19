import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * In-process dispatch marker for the collector-hosted MCP transport
 * (ADR 0051 §7, design sketch §G.1).
 *
 * `routes/mcp.ts` answers a `tools/call` by **re-entering the collector's own
 * Fastify app** with `app.inject()` rather than opening a loopback socket back
 * to itself. That keeps a tool call on exactly the same code path as the HTTP
 * read it wraps — the capability check, the project scoping, the Zod
 * querystring validation, the result-envelope hook and the audit hook all run
 * once, in one place, so the MCP surface cannot drift from the HTTP one. It
 * also means the collector never has to know its own externally reachable URL,
 * and no request-controlled value is ever turned into a network destination.
 *
 * Two things must still differ for an inner, MCP-originated request:
 *
 * 1. its audit row is the record of a **tool call**, so it is tagged
 *    `surface: "mcp-http"` instead of `"http"`; and
 * 2. the outer `POST /mcp` has already spent the caller's rate-limit budget, so
 *    charging the inner read again would halve every key's effective allowance.
 *
 * Both hang off this header. Its value is a 256-bit random token minted once
 * per collector process, held only in memory and never sent anywhere: a remote
 * client cannot guess it, so it can neither forge an `mcp-http` audit row nor
 * exempt itself from the rate limiter by sending the header.
 */
export const INTERNAL_DISPATCH_HEADER = "x-uptimizr-internal-dispatch";

/** Mint the per-process dispatch token. Never logged, never leaves the process. */
export function newInternalDispatchToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Whether this request is the collector dispatching to itself on behalf of an
 * MCP session. `false` whenever no token was minted (the hosted transport is
 * off), so the check costs nothing on a default deployment.
 */
export function isInternalDispatch(request: FastifyRequest, token: string | undefined): boolean {
  if (token == null) return false;
  const header = request.headers[INTERNAL_DISPATCH_HEADER];
  if (typeof header !== "string") return false;
  const supplied = Buffer.from(header, "utf8");
  const expected = Buffer.from(token, "utf8");
  // `timingSafeEqual` throws on a length mismatch, so compare lengths first —
  // the token's length is fixed and public, so leaking it reveals nothing.
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
