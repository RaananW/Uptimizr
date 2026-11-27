// Dedupe key for the session replay's live stream.

/**
 * Identity of a streamed event within its millisecond, for deduping the live
 * stream against what was already loaded: the type plus the field that tells
 * same-type events apart (the actor, the hit mesh, the input action).
 */
export function liveEventKey(ev: { type: string; ts?: unknown; [key: string]: unknown }): string {
  const id = ev.nodeId ?? ev.boneId ?? ev.childPath ?? ev.hitMesh ?? ev.mesh ?? ev.name ?? "";
  const sub = ev.childPath ?? ev.boneId ?? "";
  return `${ev.type}|${String(ev.ts)}|${String(id)}|${String(sub)}`;
}
