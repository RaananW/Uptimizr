import { randomUUID } from "node:crypto";
import type { AnyEvent, SceneProxy } from "@uptimizr/schema";
import {
  METADATA_LIMITS,
  MetadataLimitError,
  clampMetadataLimit,
  evaluateBucketMeasure,
  foldCustomEventVocabulary,
  toEventRow,
  MAX_ENABLED_SUBSCRIPTIONS,
  MAX_SUBSCRIPTIONS_PER_PROJECT,
  MAX_SUBSCRIPTION_EVENTS,
  SubscriptionLimitError,
  clampEventLimit,
  clampSubscriptionError,
  rowToSubscription,
  toSubscriptionColumns,
} from "@uptimizr/db";
import type {
  AgentAuditEntry,
  AnnotationRecord,
  CustomEventVocabularySampleRow,
  ApiKeyCapability,
  BucketEventLike,
  GlossaryEntryRecord,
  PanelSpecRecord,
  SavedAnalysisRecord,
  SceneRegionRecord,
  SubscriptionEventRecord,
  SubscriptionRecord,
  SceneRepresentation,
  SessionMeta,
} from "@uptimizr/db";
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
  /**
   * Capability set the {@link apiKey} resolves with. Defaults to `["query"]`
   * (reads only) — the same default as a key minted by the CLI.
   */
  capabilities?: readonly ApiKeyCapability[];
  /** Stable id reported for {@link apiKey} (the audit-log subject). */
  keyId?: string;
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
  capabilities = ["query"],
  keyId = "memory-key",
}: MemoryStoreOptions): CollectorStore {
  const events: AnyEvent[] = [];
  const representations = new Map<string, SceneRepresentation>();
  const audit: AgentAuditEntry[] = [];
  /** Scene regions keyed by scene id; each value is that scene's whole set. */
  const regions = new Map<string, SceneRegionRecord[]>();
  /** Project metadata (#310): annotations, glossary (keyed by term), analyses. */
  const annotations: AnnotationRecord[] = [];
  const glossary = new Map<string, GlossaryEntryRecord>();
  const analyses: SavedAnalysisRecord[] = [];
  /**
   * Pinned panels (#315). An array rather than a `Map` because insertion order
   * *is* the listing order here — the persistent stores order these oldest-first
   * so a pinned panel keeps its place in the grid.
   */
  const panelSpecs: PanelSpecRecord[] = [];
  /**
   * Conditional subscriptions (#311). Kept in insertion order — the persistent
   * stores order by `created_at, id`, and a `Map` preserves exactly that.
   * `secrets` is separate from the records for the same reason the stores keep
   * the secret in its own column: a record handed to a caller can then never
   * carry it, whatever the caller does with it.
   */
  const subscriptions = new Map<string, SubscriptionRecord>();
  const secrets = new Map<string, string>();
  /** Firing log per subscription id, newest last; bounded on write. */
  const firings = new Map<string, SubscriptionEventRecord[]>();
  let subscriptionSeq = 0;

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

  /**
   * Project a captured event onto the promoted columns an insight bucket
   * measure reads (ADR 0051 §4). `toEventRow` is the same mapping the
   * persistent stores insert through, so the in-memory series is computed from
   * the same columns the SQL series is — the one payload field a measure needs
   * (`ar_placement.scale`) is lifted alongside it.
   */
  const toBucketEvent = (e: AnyEvent): BucketEventLike => {
    const row = toEventRow(e);
    const scale = (e as AnyEvent & { scale?: unknown }).scale;
    return {
      ts: e.ts,
      event_type: row.event_type,
      scene_id: row.scene_id,
      session_id: row.session_id,
      mesh: row.mesh,
      name: row.name,
      source: row.source,
      fps: row.fps,
      visible_ms: row.visible_ms,
      js_heap_bytes: row.js_heap_bytes,
      long_frames: row.long_frames,
      position: row.position,
      direction: row.direction,
      hit_point: row.hit_point,
      screen: row.screen,
      ...(typeof scale === "number" ? { ar_placement_scale: scale } : {}),
    };
  };

  return {
    engine: "memory",
    resolveApiKey: async (key) =>
      key === apiKey
        ? { projectId, keyId, capabilities: [...capabilities], label: null, rateLimit: null }
        : null,
    recordAudit: async (entry) => {
      audit.push({
        id: randomUUID(),
        projectId: entry.projectId,
        keyId: entry.keyId,
        at: entry.at ?? new Date(),
        surface: entry.surface,
        toolOrPath: entry.toolOrPath,
        params: entry.params,
        rowCount: entry.rowCount ?? null,
        durationMs: entry.durationMs,
        status: entry.status,
      });
    },
    listAudit: async (id, opts = {}) =>
      audit
        .filter(
          (row) =>
            row.projectId === id &&
            (opts.since == null || row.at.getTime() >= opts.since) &&
            (opts.until == null || row.at.getTime() < opts.until),
        )
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 1000)),
    pruneAudit: async (cutoffMs) => {
      for (let i = audit.length - 1; i >= 0; i -= 1) {
        if (audit[i]!.at.getTime() < cutoffMs) audit.splice(i, 1);
      }
    },
    projectExists: async (id) => id === projectId,
    insertEvents: async (incoming) => {
      events.push(...incoming);
    },
    // The query DSL (ADR 0051 §3) compiles to SQL, and this store has no SQL
    // engine — it answers a handful of aggregates by walking the array above.
    // Rather than grow a second, JavaScript re-implementation of seventy
    // builders that could silently disagree with the real ones, it reports no
    // rows, exactly as the spatial aggregates below already do. Use the DuckDB
    // store (the OSS default) for the DSL.
    runMetric: async () => [],
    // No SQL is compiled here, so there is no plan to show; `explain` falls back
    // to the registry-derived warnings (#304).
    describeMetric: () => null,
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
    meshUvHeatmap: async () => [],
    worldHeatmap: async () => [],
    worldHeatmapStats: async () => ({ cells: 0, hits: 0 }),
    gazeHeatmap: async () => [],
    gazeHeatmapStats: async () => ({ cells: 0, hits: 0 }),
    cameraHeatmap: async () => [],
    viewCoverageHistogram: async () => [],
    cameraPositionHeatmap: async () => [],
    sessionTrajectory: async () => [],
    aggregateTrajectories: async () => [],
    clickGazeRays: async () => [],
    flowHeatmap: async () => [],
    topMeshes: async () => [],
    topMeshesBySource: async () => [],
    topMeshesTrend: async () => [],
    meshDwell: async () => [],
    meshBlindSpots: async () => [],
    meshInteractionKinds: async () => [],
    reachability: async () => [],
    deadClicks: async () => [],
    rageClicks: async () => [],
    hoverDwell: async () => [],
    compileStalls: async () => [],
    arPlacementTimeToPlace: async () => [],
    arPlacementAttempts: async () => [],
    arPlacementSurfaces: async () => [],
    resourceSummary: async () => [],
    capabilityChanges: async () => [],
    cameraGestures: async () => [],
    perfSummary: async () => [],
    renderScaleTruth: async () => [],
    perfDistribution: async () => [],
    fpsHistogram: async () => [],
    frameTimePercentiles: async () => [],
    jankRate: async () => [],
    perfChurn: async () => [],
    perfByDevice: async () => [],
    perfByScene: async () => [],
    resourcePercentiles: async () => [],
    stabilityCounts: async () => [],
    graphicsDiagnosticCounts: async () => [],
    errorHeatmap: async () => [],
    boundaryHeatmap: async () => [],
    boundaryHeatmapStats: async () => ({ cells: 0, hits: 0 }),
    renderingTechnology: async () => [],
    sceneCoverage: async () => [],
    perfHeatmap: async () => [],
    cameraDistance: async () => [],
    navigationStats: async () => [],
    backtrackRatio: async () => [],
    xrRotationRate: async () => [],
    xrSourceUsage: async () => [],
    xrAbandonment: async () => [],
    xrLocomotion: async () => [],
    boundaryContacts: async () => [],
    trackingQuality: async () => [],
    interactionsBySource: async () => [],
    topInputActions: async () => [],
    // Discovered custom-event vocabulary (ADR 0051 §5). Implemented here (unlike
    // the heavier spatial aggregates) because the playground and the demo run on
    // this store, and an empty vocabulary would make their project context
    // document silently wrong about what the app emits.
    customEventVocabulary: async (_projectId, opts = {}) => {
      const limit = Math.min(opts.limit ?? 100, 200);
      const sampleRows = Math.min(opts.sampleRows ?? 20, 100);
      const byName = new Map<string, AnyEvent[]>();
      for (const e of forProject()) {
        if (e.type !== "custom" || !inRange(e, opts)) continue;
        if (opts.scene != null && opts.scene.length > 0 && sceneOf(e) !== opts.scene) continue;
        const name = (e as { name?: unknown }).name;
        if (typeof name !== "string" || name.length === 0) continue;
        const list = byName.get(name) ?? [];
        list.push(e);
        byName.set(name, list);
      }
      const samples: CustomEventVocabularySampleRow[] = [];
      const ranked = [...byName.entries()]
        .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
        .slice(0, limit);
      for (const [name, list] of ranked) {
        const sessions = new Set(list.map((e) => e.sessionId)).size;
        const recent = [...list].sort((a, b) => b.ts - a.ts).slice(0, sampleRows);
        for (const event of recent) {
          samples.push({ name, count: list.length, sessions, sample_payload: event });
        }
      }
      return foldCustomEventVocabulary(samples);
    },
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
    // The bucket series behind `baseline` and `movers` (ADR 0051 §4). The
    // persistent stores render the declarative measure to SQL; here the same
    // measure is evaluated over the in-memory events, so the insight endpoints
    // answer in the playground and the E2E harness rather than reporting an
    // empty series — which would read as "no data", a different claim.
    metricBuckets: async (_projectId, opts) =>
      evaluateBucketMeasure(forProject().map(toBucketEvent), opts),
    funnel: async (_projectId, opts) => {
      const steps = opts.steps ?? [];
      if (steps.length === 0) return [];
      const nameOf = (e: AnyEvent): string => {
        const r = e as AnyEvent & Record<string, unknown>;
        for (const k of ["name", "phase", "kind", "action"]) {
          if (typeof r[k] === "string") return r[k] as string;
        }
        return "";
      };
      const meshOf = (e: AnyEvent): string => {
        const r = e as AnyEvent & Record<string, unknown>;
        if (typeof r.mesh === "string") return r.mesh;
        if (typeof r.hitMesh === "string") return r.hitMesh;
        return "";
      };
      const matches = (e: AnyEvent, step: (typeof steps)[number]): boolean =>
        e.type === step.type &&
        (step.name == null || step.name.length === 0 || nameOf(e) === step.name) &&
        (step.mesh == null || step.mesh.length === 0 || meshOf(e) === step.mesh);

      const bySession = new Map<string, AnyEvent[]>();
      for (const e of forProject()) {
        if (!inRange(e, opts)) continue;
        if (opts.scene != null && opts.scene.length > 0 && sceneOf(e) !== opts.scene) continue;
        const list = bySession.get(e.sessionId) ?? [];
        list.push(e);
        bySession.set(e.sessionId, list);
      }

      const counts = steps.map(() => 0);
      for (const list of bySession.values()) {
        const sorted = [...list].sort((a, b) => a.ts - b.ts);
        let prevTs = -Infinity;
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (step == null) break;
          const hit = sorted.find((e) => e.ts >= prevTs && matches(e, step));
          if (hit == null) break;
          prevTs = hit.ts;
          counts[i] = (counts[i] ?? 0) + 1;
        }
      }
      return counts.map((sessions, step) => ({ step, sessions }));
    },
    sceneRetention: async (_projectId, opts) => {
      // Per session, the ordered `scene_change` targets; each consecutive pair
      // is a directed link weighted by distinct sessions (mirrors the SQL
      // builder's semantics, #147). Sessions with < 2 markers contribute none.
      const bySession = new Map<string, AnyEvent[]>();
      for (const e of forProject()) {
        if (e.type !== "scene_change" || !inRange(e, opts)) continue;
        const list = bySession.get(e.sessionId) ?? [];
        list.push(e);
        bySession.set(e.sessionId, list);
      }

      // Count each session at most once per (from, to) link.
      const sessionsByLink = new Map<string, Set<string>>();
      for (const [sessionId, list] of bySession) {
        const scenes = [...list].sort((a, b) => a.ts - b.ts).map(sceneOf);
        for (let i = 1; i < scenes.length; i++) {
          const key = `${scenes[i - 1]}\u0000${scenes[i]}`;
          const set = sessionsByLink.get(key) ?? new Set<string>();
          set.add(sessionId);
          sessionsByLink.set(key, set);
        }
      }

      const rows = [...sessionsByLink].map(([key, set]) => {
        const [from_scene, to_scene] = key.split("\u0000");
        return { from_scene: from_scene ?? "", to_scene: to_scene ?? "", sessions: set.size };
      });
      rows.sort(
        (a, b) =>
          b.sessions - a.sessions ||
          a.from_scene.localeCompare(b.from_scene) ||
          a.to_scene.localeCompare(b.to_scene),
      );
      return rows.slice(0, opts.limit ?? 100);
    },
    loadBounceFunnel: async () => [],
    variantLeaderboard: async (_projectId, opts) => {
      const nameOf = (e: AnyEvent): string => {
        const r = e as AnyEvent & Record<string, unknown>;
        for (const k of ["name", "phase", "kind", "action"]) {
          if (typeof r[k] === "string") return r[k] as string;
        }
        return "";
      };
      const meshOf = (e: AnyEvent): string => {
        const r = e as AnyEvent & Record<string, unknown>;
        if (typeof r.mesh === "string") return r.mesh;
        if (typeof r.hitMesh === "string") return r.hitMesh;
        return "";
      };
      type Pred = { type: string; name?: string; mesh?: string };
      const matches = (e: AnyEvent, step: Pred): boolean =>
        e.type === step.type &&
        (step.name == null || step.name.length === 0 || nameOf(e) === step.name) &&
        (step.mesh == null || step.mesh.length === 0 || meshOf(e) === step.mesh);
      const scoped = (e: AnyEvent): boolean =>
        inRange(e, opts) &&
        (opts.scene == null || opts.scene.length === 0 || sceneOf(e) === opts.scene);

      const variantStep: Pred = opts.variant ?? { type: "custom" };
      const conversionStep = opts.conversion;

      // (session → sorted variant views) and (session → sorted conversion ts).
      const viewsBySession = new Map<string, { variant: string; ts: number }[]>();
      const convBySession = new Map<string, number[]>();
      for (const e of forProject()) {
        if (!scoped(e)) continue;
        if (matches(e, variantStep)) {
          const list = viewsBySession.get(e.sessionId) ?? [];
          list.push({ variant: nameOf(e), ts: e.ts });
          viewsBySession.set(e.sessionId, list);
        }
        if (conversionStep != null && matches(e, conversionStep)) {
          const list = convBySession.get(e.sessionId) ?? [];
          list.push(e.ts);
          convBySession.set(e.sessionId, list);
        }
      }

      type Acc = {
        views: number;
        sessions: Set<string>;
        converted: Set<string>;
        dwellSum: number;
        dwellSamples: number;
      };
      const acc = new Map<string, Acc>();
      const get = (v: string): Acc => {
        let a = acc.get(v);
        if (a == null) {
          a = { views: 0, sessions: new Set(), converted: new Set(), dwellSum: 0, dwellSamples: 0 };
          acc.set(v, a);
        }
        return a;
      };

      for (const [session, views] of viewsBySession) {
        const convTs = convBySession.get(session) ?? [];
        // First view of each variant in this session (ordered anchor).
        const firstView = new Map<string, number>();
        for (const { variant, ts } of views) {
          if (!firstView.has(variant) || ts < (firstView.get(variant) as number)) {
            firstView.set(variant, ts);
          }
        }
        for (const { variant, ts } of views) {
          const a = get(variant);
          a.views += 1;
          a.sessions.add(session);
          // Next boundary: earliest later conversion OR later different-variant view.
          let boundary = Infinity;
          for (const c of convTs) if (c > ts && c < boundary) boundary = c;
          for (const other of views) {
            if (other.ts > ts && other.variant !== variant && other.ts < boundary) {
              boundary = other.ts;
            }
          }
          if (boundary !== Infinity) {
            a.dwellSum += boundary - ts;
            a.dwellSamples += 1;
          }
        }
        // Conversions: sessions that fired the conversion at/after first view.
        if (conversionStep != null) {
          for (const [variant, t0] of firstView) {
            if (convTs.some((c) => c >= t0)) get(variant).converted.add(session);
          }
        }
      }

      const rows = [...acc.entries()].map(([variant, a]) => ({
        variant,
        views: a.views,
        sessions: a.sessions.size,
        conversions: a.converted.size,
        avg_dwell_ms: a.dwellSamples > 0 ? a.dwellSum / a.dwellSamples : 0,
      }));
      rows.sort((x, y) => y.views - x.views || (x.variant < y.variant ? -1 : 1));
      return rows.slice(0, opts.limit ?? 50);
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
    // Regions are replace-the-set, exactly like the persistent stores: the map
    // entry IS the scene's whole set, so an empty array clears it.
    putSceneRegions: async (_projectId, sceneId, input) => {
      const now = new Date();
      const stored: SceneRegionRecord[] = [...input]
        .map((region) => ({
          projectId,
          sceneId,
          regionId: region.id,
          label: region.label,
          description: region.description ?? null,
          bounds: region.bounds,
          updatedAt: now,
        }))
        .sort((a, b) => (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0));
      regions.set(sceneId, stored);
      return stored;
    },
    getSceneRegions: async (_projectId, sceneId) => regions.get(sceneId) ?? [],
    listSceneRegions: async () =>
      [...regions.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .flatMap(([sceneId, set]) =>
          set.map((r) => ({ sceneId, regionId: r.regionId, label: r.label })),
        ),
    // --- Project metadata (#310, ADR 0051 §5) ------------------------------
    // Same semantics as the persistent stores — per-project caps, newest-first
    // ordering, overlap filtering, `MetadataLimitError` when a table is full —
    // so an E2E run against this store exercises the real contract.
    createAnnotation: async (_projectId, input) => {
      if (annotations.length >= METADATA_LIMITS.annotations) {
        throw new MetadataLimitError("annotations", METADATA_LIMITS.annotations);
      }
      const now = new Date();
      const { annotation } = input;
      const record: AnnotationRecord = {
        id: randomUUID(),
        projectId,
        targetKind: annotation.targetKind,
        targetId: annotation.targetId ?? null,
        since: annotation.since == null ? null : new Date(annotation.since),
        until: annotation.until == null ? null : new Date(annotation.until),
        text: annotation.text,
        authorKind: input.authorKind,
        authorKeyId: input.authorKeyId,
        createdAt: now,
        updatedAt: now,
      };
      annotations.push(record);
      return record;
    },
    listAnnotations: async (_projectId, opts = {}) =>
      annotations
        .filter((row) => opts.targetKind == null || row.targetKind === opts.targetKind)
        .filter((row) => opts.targetId == null || row.targetId === opts.targetId)
        .filter(
          (row) => opts.since == null || row.until == null || row.until.getTime() >= opts.since,
        )
        .filter(
          (row) => opts.until == null || row.since == null || row.since.getTime() < opts.until,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, clampMetadataLimit(opts.limit)),
    deleteAnnotation: async (_projectId, id) => {
      const index = annotations.findIndex((row) => row.id === id);
      if (index < 0) return false;
      annotations.splice(index, 1);
      return true;
    },
    putGlossaryEntry: async (_projectId, input) => {
      const { term, meaning } = input.entry;
      if (!glossary.has(term) && glossary.size >= METADATA_LIMITS.glossary) {
        throw new MetadataLimitError("glossary", METADATA_LIMITS.glossary);
      }
      const record: GlossaryEntryRecord = { projectId, term, meaning, updatedAt: new Date() };
      glossary.set(term, record);
      return record;
    },
    listGlossary: async (_projectId, opts = {}) =>
      [...glossary.values()]
        .sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
        .slice(
          0,
          clampMetadataLimit(opts.limit, METADATA_LIMITS.glossary, METADATA_LIMITS.glossary),
        ),
    deleteGlossaryEntry: async (_projectId, term) => glossary.delete(term),
    createSavedAnalysis: async (_projectId, input) => {
      if (analyses.length >= METADATA_LIMITS.savedAnalyses) {
        throw new MetadataLimitError("savedAnalyses", METADATA_LIMITS.savedAnalyses);
      }
      const { analysis } = input;
      const record: SavedAnalysisRecord = {
        id: randomUUID(),
        projectId,
        title: analysis.title,
        query: analysis.query,
        conclusion: analysis.conclusion ?? null,
        authorKind: input.authorKind,
        authorKeyId: input.authorKeyId,
        createdAt: new Date(),
      };
      analyses.push(record);
      return record;
    },
    listSavedAnalyses: async (_projectId, opts = {}) =>
      [...analyses]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, clampMetadataLimit(opts.limit)),
    deleteSavedAnalysis: async (_projectId, id) => {
      const index = analyses.findIndex((row) => row.id === id);
      if (index < 0) return false;
      analyses.splice(index, 1);
      return true;
    },
    // --- Declarative panel specs (#315, ADR 0051 §7) ---------------------
    createPanelSpec: async (_projectId, input) => {
      if (panelSpecs.length >= METADATA_LIMITS.panelSpecs) {
        throw new MetadataLimitError("panelSpecs", METADATA_LIMITS.panelSpecs);
      }
      const now = new Date();
      const record: PanelSpecRecord = {
        id: randomUUID(),
        projectId,
        spec: input.spec,
        authorKind: input.authorKind,
        authorKeyId: input.authorKeyId,
        createdAt: now,
        updatedAt: now,
      };
      panelSpecs.push(record);
      return record;
    },
    // Oldest first, which is insertion order — a pinned panel keeps its place.
    listPanelSpecs: async (_projectId, opts = {}) =>
      panelSpecs.slice(
        0,
        clampMetadataLimit(opts.limit, METADATA_LIMITS.panelSpecs, METADATA_LIMITS.panelSpecs),
      ),
    updatePanelSpec: async (_projectId, id, input) => {
      const index = panelSpecs.findIndex((row) => row.id === id);
      if (index < 0) return null;
      // The row keeps its id, its position and its original authorship — an
      // edit is not a new pin.
      const updated: PanelSpecRecord = {
        ...panelSpecs[index]!,
        spec: input.spec,
        updatedAt: new Date(),
      };
      panelSpecs[index] = updated;
      return updated;
    },
    deletePanelSpec: async (_projectId, id) => {
      const index = panelSpecs.findIndex((row) => row.id === id);
      if (index < 0) return false;
      panelSpecs.splice(index, 1);
      return true;
    },
    // --- Conditional subscriptions (#311, ADR 0051 §6) -------------------
    listSubscriptions: async () => [...subscriptions.values()],
    listEnabledSubscriptions: async (limit) =>
      [...subscriptions.values()]
        .filter((sub) => sub.enabled)
        .slice(0, Math.max(1, Math.trunc(limit ?? MAX_ENABLED_SUBSCRIPTIONS))),
    getSubscription: async (_projectId, id) => subscriptions.get(id) ?? null,
    createSubscription: async (_projectId, sub) => {
      if (subscriptions.size >= MAX_SUBSCRIPTIONS_PER_PROJECT) throw new SubscriptionLimitError();
      const id = `sub_mem_${++subscriptionSeq}`;
      const cols = toSubscriptionColumns(sub);
      const now = Date.now();
      // Round-trip through the shared row mapper rather than hand-building the
      // record, so the in-memory store cannot drift from the four SQL stores
      // (masking included).
      const record = rowToSubscription({
        id,
        project_id: projectId,
        name: cols.name,
        metric: cols.metric,
        config: cols.config,
        enabled: cols.enabled,
        created_at_ms: now,
        updated_at_ms: now,
        last_fired_at_ms: null,
        last_error: null,
        failures: 0,
      });
      subscriptions.set(id, record);
      if (cols.webhookSecret != null) secrets.set(id, cols.webhookSecret);
      return record;
    },
    setSubscriptionEnabled: async (_projectId, id, enabled) => {
      const existing = subscriptions.get(id);
      if (existing == null) return null;
      const updated = { ...existing, enabled, updatedAt: new Date() };
      subscriptions.set(id, updated);
      return updated;
    },
    deleteSubscription: async (_projectId, id) => {
      secrets.delete(id);
      firings.delete(id);
      return subscriptions.delete(id);
    },
    recordSubscriptionOutcome: async (_projectId, id, outcome) => {
      const existing = subscriptions.get(id);
      if (existing == null) return;
      subscriptions.set(id, {
        ...existing,
        updatedAt: new Date(),
        lastFiredAt: outcome.firedAt ?? existing.lastFiredAt,
        lastError:
          outcome.lastError === undefined
            ? existing.lastError
            : outcome.lastError == null
              ? null
              : clampSubscriptionError(outcome.lastError),
        failures: outcome.failures ?? existing.failures,
      });
    },
    getWebhookSecret: async (_projectId, id) => secrets.get(id) ?? null,
    recordSubscriptionEvent: async (entry) => {
      const log = firings.get(entry.subscriptionId) ?? [];
      log.push({
        id: randomUUID(),
        subscriptionId: entry.subscriptionId,
        projectId: entry.projectId,
        at: entry.at ?? new Date(),
        payload: entry.payload,
      });
      // Same bound as every persistent store: the oldest fall off the front.
      while (log.length > MAX_SUBSCRIPTION_EVENTS) log.shift();
      firings.set(entry.subscriptionId, log);
    },
    listSubscriptionEvents: async (_projectId, id, opts) =>
      [...(firings.get(id) ?? [])].reverse().slice(0, clampEventLimit(opts?.limit)),
    close: async () => {
      events.length = 0;
      representations.clear();
      regions.clear();
      annotations.length = 0;
      glossary.clear();
      analyses.length = 0;
      panelSpecs.length = 0;
      subscriptions.clear();
      secrets.clear();
      firings.clear();
    },
  };
}
