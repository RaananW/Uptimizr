import type { AnyEvent, SceneProxy } from "@uptimizr/schema";
import type { ApiKeyCapability, SceneRepresentation, SessionMeta } from "@uptimizr/db";
import type { CollectorStore } from "./store.js";

/** A `session_start` event narrowed to the descriptor fields we surface as meta. */
interface SessionStartLike {
  type: "session_start";
  sessionId: string;
  ts: number;
  device?: SessionMeta["device"];
  scene?: SessionMeta["scene"];
  user?: SessionMeta["user"];
}

function isSessionStart(event: AnyEvent): event is AnyEvent & SessionStartLike {
  return event.type === "session_start";
}

export interface MemoryStoreOptions {
  /** The single project id this store serves. */
  projectId: string;
  /** The plaintext API key that resolves to {@link projectId}. */
  apiKey: string;
  /** Capability the {@link apiKey} resolves with. Defaults to `query` (reads). */
  capability?: ApiKeyCapability;
}

/**
 * In-memory {@link CollectorStore} for local development and end-to-end tests —
 * it boots the collector without ClickHouse or Postgres. Events are kept in a
 * plain array; the replay-relevant reads (session list, ordered timeline, coarse
 * meta) and the lightweight aggregates (scenes, time-series, event-type counts)
 * are served from it so the playground's filters and timeline work. The
 * heavier spatial aggregates (heatmaps, perf, top meshes) are intentionally not
 * implemented here and return empty results; use the ClickHouse-backed store for
 * those. Never use this in production.
 */
export function createMemoryStore({
  projectId,
  apiKey,
  capability = "query",
}: MemoryStoreOptions): CollectorStore {
  const events: AnyEvent[] = [];
  const representations = new Map<string, SceneRepresentation>();

  const forSession = (sid: string): AnyEvent[] =>
    events
      .filter((e) => e.projectId === projectId && e.sessionId === sid)
      .sort((a, b) => a.ts - b.ts);

  const forProject = (): AnyEvent[] => events.filter((e) => e.projectId === projectId);
  const sceneOf = (e: AnyEvent): string => {
    const s = (e as { sceneId?: unknown }).sceneId;
    return typeof s === "string" && s.length > 0 ? s : "default";
  };
  const inRange = (e: AnyEvent, opts: { since?: number; until?: number }): boolean =>
    (opts.since == null || e.ts >= opts.since) && (opts.until == null || e.ts < opts.until);

  return {
    resolveApiKey: async (key) => (key === apiKey ? { projectId, capability } : null),
    projectExists: async (id) => id === projectId,
    insertEvents: async (incoming) => {
      events.push(...incoming);
    },
    listSessions: async () => {
      const bySession = new Map<string, AnyEvent[]>();
      for (const e of events) {
        if (e.projectId !== projectId) continue;
        const list = bySession.get(e.sessionId) ?? [];
        list.push(e);
        bySession.set(e.sessionId, list);
      }
      return [...bySession.entries()].map(([sessionId, list]) => {
        const sorted = [...list].sort((a, b) => a.ts - b.ts);
        const first = sorted[0]!;
        const last = sorted[sorted.length - 1]!;
        const visitor = sorted.find(
          (e): e is AnyEvent & { visitorId: string } =>
            typeof (e as { visitorId?: unknown }).visitorId === "string",
        );
        return {
          session_id: sessionId,
          visitor_id: visitor?.visitorId ?? "",
          events: sorted.length,
          started_at: new Date(first.ts).toISOString(),
          ended_at: new Date(last.ts).toISOString(),
        };
      });
    },
    pointerHeatmap: async () => [],
    worldHeatmap: async () => [],
    gazeHeatmap: async () => [],
    cameraHeatmap: async () => [],
    cameraPositionHeatmap: async () => [],
    sessionTrajectory: async () => [],
    aggregateTrajectories: async () => [],
    clickGazeRays: async () => [],
    flowHeatmap: async () => [],
    topMeshes: async () => [],
    meshDwell: async () => [],
    meshInteractionKinds: async () => [],
    deadClicks: async () => [],
    rageClicks: async () => [],
    hoverDwell: async () => [],
    compileStalls: async () => [],
    resourceSummary: async () => [],
    capabilityChanges: async () => [],
    cameraGestures: async () => [],
    perfSummary: async () => [],
    renderScaleTruth: async () => [],
    perfDistribution: async () => [],
    fpsHistogram: async () => [],
    frameTimePercentiles: async () => [],
    jankRate: async () => [],
    perfByDevice: async () => [],
    perfByScene: async () => [],
    resourcePercentiles: async () => [],
    stabilityCounts: async () => [],
    sceneCoverage: async () => [],
    cameraDistance: async () => [],
    navigationStats: async () => [],
    xrRotationRate: async () => [],
    xrSourceUsage: async () => [],
    xrAbandonment: async () => [],
    interactionsBySource: async () => [],
    scenes: async (_projectId, opts = {}) => {
      const map = new Map<string, { events: number; last: number }>();
      for (const e of forProject()) {
        if (!inRange(e, opts)) continue;
        const sid = sceneOf(e);
        const cur = map.get(sid) ?? { events: 0, last: 0 };
        cur.events += 1;
        cur.last = Math.max(cur.last, e.ts);
        map.set(sid, cur);
      }
      return [...map.entries()]
        .map(([scene_id, v]) => ({
          scene_id,
          events: v.events,
          last_seen: new Date(v.last).toISOString(),
        }))
        .sort((a, b) => b.events - a.events)
        .slice(0, opts.limit ?? 200);
    },
    timeseries: async (_projectId, opts = {}) => {
      const interval = (opts.interval ?? 3600) * 1000;
      const buckets = new Map<number, { events: number; fpsSum: number; fpsCount: number }>();
      for (const e of forProject()) {
        if (!inRange(e, opts)) continue;
        if (opts.scene != null && opts.scene.length > 0 && sceneOf(e) !== opts.scene) continue;
        if (opts.type != null && opts.type.length > 0 && e.type !== opts.type) continue;
        const bucket = Math.floor(e.ts / interval) * interval;
        const cur = buckets.get(bucket) ?? { events: 0, fpsSum: 0, fpsCount: 0 };
        cur.events += 1;
        if (e.type === "frame_perf") {
          const fps = (e as { fps?: unknown }).fps;
          if (typeof fps === "number") {
            cur.fpsSum += fps;
            cur.fpsCount += 1;
          }
        }
        buckets.set(bucket, cur);
      }
      return [...buckets.entries()]
        .map(([bucket, v]) => ({
          bucket,
          events: v.events,
          avg_fps: v.fpsCount > 0 ? v.fpsSum / v.fpsCount : 0,
        }))
        .sort((a, b) => a.bucket - b.bucket);
    },
    eventTypeCounts: async (_projectId, opts = {}) => {
      const map = new Map<string, number>();
      for (const e of forProject()) {
        if (!inRange(e, opts)) continue;
        if (opts.scene != null && opts.scene.length > 0 && sceneOf(e) !== opts.scene) continue;
        map.set(e.type, (map.get(e.type) ?? 0) + 1);
      }
      return [...map.entries()]
        .map(([event_type, count]) => ({ event_type, count }))
        .sort((a, b) => b.count - a.count);
    },
    getSessionEvents: async (_projectId, sessionId) => forSession(sessionId),
    streamSessionEvents: async function* (_projectId, sessionId) {
      for (const e of forSession(sessionId)) yield e;
    },
    getSessionMeta: async (_projectId, sessionId) => {
      const start = forSession(sessionId).find(isSessionStart);
      if (!start) return null;
      return {
        sessionId,
        startedAt: new Date(start.ts).toISOString(),
        device: start.device,
        scene: start.scene,
        user: start.user,
      };
    },
    putSceneProxy: async (_projectId, proxy: SceneProxy, label) => {
      const existing = representations.get(proxy.sceneId);
      const now = new Date();
      const representation: SceneRepresentation = {
        projectId,
        sceneId: proxy.sceneId,
        label: label ?? existing?.label ?? null,
        kind: "proxy",
        upAxis: proxy.upAxis,
        unitScale: proxy.unitScale,
        bounds: proxy.bounds,
        proxy,
        assetUrl: null,
        contentHash: proxy.contentHash,
        proxyVersion: proxy.version,
        capturedAt: new Date(proxy.capturedAt),
        updatedAt: now,
      };
      representations.set(proxy.sceneId, representation);
      return representation;
    },
    getSceneRepresentation: async (_projectId, sceneId) => representations.get(sceneId) ?? null,
    listSceneRepresentations: async () =>
      [...representations.values()]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((r) => ({
          sceneId: r.sceneId,
          label: r.label,
          kind: r.kind,
          bounds: r.bounds,
          contentHash: r.contentHash,
          capturedAt: r.capturedAt,
          updatedAt: r.updatedAt,
        })),
    close: async () => {
      events.length = 0;
      representations.clear();
    },
  };
}
