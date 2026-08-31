# @uptimizr/react

## 0.13.1

### Patch Changes

- Updated dependencies [0af8209]
  - @uptimizr/agent-core@0.3.1
  - @uptimizr/replay@0.2.6
  - @uptimizr/schema@0.6.1

## 0.13.0

### Minor Changes

- 0e8b8a8: Add the `ar_placement` event and AR placement funnel analytics (#156, ADR 0048).

  - **schema:** new source-neutral `ar_placement` event, emitted once per placement
    "settle" for retail "view in your room" AR — `mesh`, final world `position`, coarse
    `surface` (`floor`/`wall`/`table`/`ceiling`/`unknown`), `attempts`, `timeToPlaceMs`,
    `scale`, and `final`. Reuses the promoted `mesh`/`position` columns, so no DB
    migration.
  - **@uptimizr/babylon:** `babylonArPlacementCollector` captures WebXR hit-test/anchor
    placement and enqueues one `ar_placement` per settle, classifying the surface coarsely
    from the hit normal (`classifyArSurface`). Coarse, on-device-only signals (ADR 0003).
  - **@uptimizr/db:** dialect-agnostic `buildArPlacementTimeToPlace`,
    `buildArPlacementAttempts`, and `buildArPlacementSurfaces` builders for the placement
    funnel (time-to-place distribution, re-placement count, surface breakdown), with parity
    cases.
  - **@uptimizr/react:** `arPlacementTimeToPlace` / `arPlacementAttempts` /
    `arPlacementSurfaces` API methods and an **AR placement funnel** dashboard panel.

- 6d883d0: Add guardian / boundary-touch spatial analytics for room-scale VR (#157, ADR 0048).

  - **schema:** new `xr_boundary_proximity` event — a coarse voxel-binned `position` (HMD position at
    the closest approach) plus `durationMs` (time within the near-boundary zone). One event per
    approach; count is implied by frequency.
  - **sdk-babylon:** opt-in `babylonBoundaryCollector` detects, entirely on-device, when the tracked
    WebXR pose comes within a near threshold (default 0.5 m) of a bounded reference space's guardian
    boundary and emits one event per approach. The boundary polygon / room geometry is **never**
    transmitted (ADR 0003 / ADR 0048).
  - **@uptimizr/db:** dialect-agnostic `buildBoundaryHeatmap`, `buildBoundaryHeatmapStats`, and
    `buildBoundaryContacts` builders that reuse the existing world-heatmap voxel path (no migration —
    the promoted `position` column is reused).
  - **collector-server:** new `GET /api/v1/heatmaps/boundary`, `/api/v1/heatmaps/boundary/stats`, and
    `/api/v1/xr/boundary-contacts` endpoints.
  - **@uptimizr/react:** a boundary-touch heatmap panel (3D, reusing the world-heatmap render path) and
    a per-session guardian boundary-contacts comfort panel, both registered in the OSS panel catalog.

- 8041ca2: Add an XR **tracking-quality timeline** (#155, ADR 0048) by extending the existing
  `capability_change` event with a new `"tracking"` kind — events live once, no new
  event type, no DB migration.

  - **schema.** `capabilityChangeKindSchema` gains `"tracking"`, and
    `capabilityChangeSchema` now spreads `inputSourceShape` (`source` / `handedness`)
    and an optional `durationMs` (the completed degraded-episode length). A tracking
    transition reuses the event's existing `from` / `to` / `reason` shape (e.g.
    `"hand"` → `"lost"`, `"6dof"` → `"3dof"`).
  - **sdk-core.** `reportCapabilityChange(...)` threads `source` / `handedness` /
    `durationMs` through, and the XR capture options gain a `tracking` toggle.
  - **@uptimizr/babylon.** The XR collector reports coarse, best-effort tracking
    loss/recovery — when a hand or controller drops out of the input registry
    mid-session it emits one `capability_change { kind: "tracking" }` per completed
    degraded episode (via the same `reportCapabilityChange` path as `device-recovery`).
  - **@uptimizr/db.** New dialect-agnostic `buildTrackingQuality(projectId, opts, d)`
    aggregation (per session: `degraded_ms`, `hand_degraded_ms`,
    `controller_degraded_ms`, `degraded_episodes`, span) plus a `PARITY_CASES` entry so
    DuckDB and ClickHouse stay provably equal. The degraded duration reuses the shared
    `visible_ms` column.
  - **@uptimizr/react.** New `trackingQuality()` API method (`GET /api/v1/xr/tracking`)
    and a **Tracking quality** catalog panel (share of session time degraded, split by
    hand vs. controller) surfaced on the overview alongside scene health.

### Patch Changes

- Updated dependencies [0e8b8a8]
- Updated dependencies [6d883d0]
- Updated dependencies [8041ca2]
  - @uptimizr/schema@0.6.0
  - @uptimizr/replay@0.2.5

## 0.12.1

### Patch Changes

- d5b1f23: fix(react): stop the assistant tool-activity list overlapping the chat column

  In `<AssistantPanel>`, the fixed-height (`max-h-[24rem]`) flex-column scroll
  container let the conversation `<ol>` (which has `min-h-[8rem]`) shrink below its
  content under pressure, so its `overflow:visible` messages spilled over the
  following "Tool activity" list and painted on top of it. The scroll children are
  now `shrink-0`, so the column keeps its natural height and the container scrolls
  as one unit — the two regions can no longer visually collide. Consecutive
  identical tool calls (e.g. `top_meshes` ×12) are also folded into a single
  counted row so the list stays readable.

## 0.12.0

### Minor Changes

- dd34af8: Make the local (WebLLM) analytics assistant genuinely useful, not just
  non-crashing, within the in-browser 7–8B Hermes ceiling (ADR 0050).

  - **Current-time grounding.** The assistant now stamps the current time (ISO 8601
    - epoch ms) into the system prompt at send time via a new
      `composeSystemPrompt(base, nowMs)` helper and an injectable `useAssistant({ now })`
      clock (default `Date.now`). Small local models can finally resolve relative
      ranges ("today", "this week", "last 24h") into concrete `since`/`until` args —
      the fix for simple time-scoped questions returning no answer.
  - **Focused core tool set for local.** `@uptimizr/agent-core` adds
    `coreReadTools`, `CORE_READ_TOOL_NAMES`, and `selectReadTools(kind)` — a
    filtered VIEW of the existing `readTools` (schema still lives once). The React
    hook sends the ~7-tool core subset to the **local** backend and the full 20 to
    **hosted** backends, so a 4-bit local model isn't overwhelmed.
  - **Strongest curated default.** `CURATED_MODELS` is reordered strongest-first so
    the default is Hermes 3 (Llama 3.1 8B); all three stay selectable.
  - **Guided example prompts** in `<AssistantPanel>` (single-core-tool starter
    questions) and an honest local-vs-hosted capability note.

### Patch Changes

- Updated dependencies [dd34af8]
  - @uptimizr/agent-core@0.3.0

## 0.11.3

### Patch Changes

- 59b12c5: Make the in-browser analytics assistant show that it is working and never hide
  its reply. `<AssistantPanel>` now renders an always-visible spinner + status
  label (`Loading model…` / `Running analytics…` / `Thinking…`) in an `aria-live`
  region while a turn is in flight — so non-streaming local (WebLLM) generation no
  longer looks frozen. A turn that finishes without a natural-language answer now
  shows an explicit, non-error info line instead of rendering nothing: derived
  from the agent loop's own signals, it distinguishes the model stopping with no
  text from it hitting the step cap while tool-calling (reporting how many steps it
  took and suggesting a next step). `useAssistant` exposes a typed `notice`
  (`{ kind: "no_answer" } | { kind: "stopped_on_max_steps"; steps }`) for custom
  UIs, and its default `maxSteps` is raised to 12 (scoped to the assistant; the
  shared `@uptimizr/agent-core` default is unchanged) so small local models have
  room to wrap up. The conversation area also scrolls and auto-follows the newest
  message.
- 8ec1cdb: Explain local-model browser-storage limits instead of a raw "quota exceeded".

  The local WebLLM backend caches each curated model's ~4 GB of weights in the
  browser's Cache Storage; loading or switching among several models accumulates
  multiple copies until the per-origin quota is exceeded, at which point the Cache
  API throws a `QuotaExceededError` DOMException. Previously the assistant rendered
  that bare "Quota exceeded." string, which reads like an LLM API quota even though
  the local backend has zero network egress.

  `@uptimizr/agent-core` now classifies that DOMException (by `instanceof`/`.name`,
  never a regex) and rethrows it as a typed `WebLlmStorageError` with an actionable
  message, from both engine init and generation, while leaving all other errors
  untouched. A best-effort `navigator.storage.estimate()` preflight fails fast
  before a multi-GB download when free space is clearly insufficient (guarded and
  soft — skipped when the API is unavailable or reports ample space). Each
  `CuratedModel` gains a numeric `downloadBytes` field for that comparison, and
  `WebLlmStorageError` / `isQuotaExceededError` are exported.

  `@uptimizr/react`'s `<AssistantPanel>` now renders distinct, accessible guidance
  (free disk space, clear this site's cached data, try the smallest model or a
  hosted backend) for a `WebLlmStorageError`, keeping the generic rendering for all
  other errors.

- Updated dependencies [d12c2f4]
- Updated dependencies [ae5bcd9]
- Updated dependencies [8ec1cdb]
  - @uptimizr/agent-core@0.2.2

## 0.11.2

### Patch Changes

- a6eb8c7: fix(assistant): let users return to backend selection and switch local↔hosted anytime.
  The `<AssistantPanel>` now exposes a discoverable **Change backend** control that reopens the
  side-by-side selection cards at any time (with a **Back to chat** escape), so a committed backend
  is no longer a dead end. Switching between local and hosted works end to end (the previous model
  is released, freeing GPU memory), and re-picking the same kind prefills the current model/key.

## 0.11.1

### Patch Changes

- Updated dependencies [b18c955]
  - @uptimizr/agent-core@0.2.1

## 0.11.0

### Minor Changes

- 90e1bea: feat(react): explicit first-run LLM backend chooser for the assistant (ADR 0050 §4, amended).

  `useAssistant` and `<AssistantPanel>` no longer auto-select a backend on first open. Previously a
  WebGPU machine was pre-selected into the local (WebLLM) backend, dropping a first-time user straight
  onto the ~4 GB model-download gate without seeing the hosted alternative.

  - `useAssistant`: when no explicit `backend` is passed and none is persisted, the selection now
    starts **unselected** (`null`) — nothing loads until the user chooses. The explicit-`backend` and
    persisted-choice fast paths are unchanged, so returning users are never re-prompted.
  - `<AssistantPanel>`: on first run it renders a **chooser** presenting both backends side by side
    with honest tradeoffs (including the hosted data-egress caveat), local shown disabled with a
    "requires a WebGPU browser" note when WebGPU is unavailable and highlighted as _Recommended_ when
    it is. Picking an option routes into the existing per-backend config (local model dropdown +
    download consent, or the hosted endpoint/key/model form). The choice persists; subsequent opens go
    straight to the chat, and the backend can still be changed later under **Backend**.

- 306f5ab: feat(react): ship the in-browser analytics assistant as a portable, code-split export — a drop-in
  `<AssistantPanel>` and a headless `useAssistant()` hook from the new `@uptimizr/react/assistant`
  subpath (ADR 0050 §2, ADR 0047).

  - `useAssistant()` wraps `@uptimizr/agent-core`'s `runAgent` tool-calling loop: it manages the
    conversation history and per-turn state, the user-selected LLM backend (persisted via agent-core's
    config helpers), live tool-call progress, and WebLLM download/init progress. The loop runs
    entirely client-side against the **same** read-only `CollectorApi` client the panels use (no new
    transport, no Uptimizr server component).
  - `<AssistantPanel>` is a drop-in chat UI on the hook: message list, input, a local-WebLLM vs
    bring-your-own-hosted backend/model picker, the WebLLM download-consent prompt + progress bar, and
    clear privacy messaging.
  - LLM deps stay **optional and code-split**: importing the core `@uptimizr/react` barrel pulls zero
    assistant/LLM code, the provider factories are `import()`-ed on first use, and `@mlc-ai/web-llm`
    remains an optional peer loaded lazily by agent-core — exactly like `@uptimizr/react/panels-3d`
    code-splits Babylon.
  - Adds a read-only `CollectorApi.read()` passthrough and a non-throwing `useOptionalUptimizr()` so
    the assistant reuses an ambient `<UptimizrProvider>` connection or explicit `collectorUrl`/`apiKey`
    props.

### Patch Changes

- 59fd29b: docs: refresh package and app READMEs to match current source

  Reconcile every package/app README with the actual code — corrected package/connector
  lists, public APIs and options, CLI flags, env vars, ports, the event catalog, and
  cross-links. Also drop "Google Analytics" references in favor of neutral "web analytics"
  wording. Documentation-only; no runtime behavior changes.

- Updated dependencies [dd6e3f8]
- Updated dependencies [36f78e8]
- Updated dependencies [f3ca500]
- Updated dependencies [aaf0ea7]
- Updated dependencies [59fd29b]
  - @uptimizr/agent-core@0.2.0
  - @uptimizr/heatmap@0.1.3
  - @uptimizr/replay@0.2.4
  - @uptimizr/schema@0.5.1

## 0.10.0

### Minor Changes

- cb8d377: Route the Session Replay catalog panel through the panel contract's data seam so
  it works on any host that backs `ctx.api` — not just a browser talking straight
  to a collector with a project key.

  `CollectorApi` gains two additive methods:

  - `sessionEvents(sessionId)` — the session's ordered raw events (the ADR 0015
    replay backfill), fetched from the collector's replay endpoint with the key.
  - `liveSession(sessionId, handler, options?)` — a subscription-style per-session
    live tail mirroring `PanelLive.subscribe`, returning an unsubscribe function.
    Each `CollectorApi` implementation owns its own connection details (a host can
    add cookies / `withCredentials`, which a URL + token can't express). The
    existing `liveToken` / `liveSessionUrl` builders stay for other consumers.

  `SessionReplayView` now takes `api: CollectorApi` (instead of `baseUrl`/`apiKey`)
  and backfills + live-tails purely through those seams; the Flow Sankey panel is
  switched to `ctx.api` the same way. A static assertion now enforces that no
  catalog panel reads `ctx.baseUrl` / `ctx.apiKey` or constructs its own client —
  all data flows through `ctx.api` / `ctx.live`.

  Hosts that back `ctx.api` get session replay (historical + live-tail) for free
  and can drop any same-id substitute panel, implementing the two new
  `CollectorApi` methods against their own cookie-authed replay + per-session tail.

## 0.9.0

### Minor Changes

- 02e5ac8: Session Replay and Live Presence are now portable panels in `ossPanelCatalog`
  (ADR 0049). Adds `sessionReplayPanel` (session surface, Babylon-backed and
  code-split; view also exported as `SessionReplayView` from
  `@uptimizr/react/panels-3d`) and `livePresencePanel` (overview surface,
  Babylon-free) with the `LivePresenceView` body. The per-session live-follow hook
  `useLiveSession` and the `LiveStatus` / `LiveSessionState` types move into the
  package, and `PanelLive` gains a `status` field so panels can render connection
  badges from context.

## 0.8.1

### Patch Changes

- c4863de: fix(react,dashboard): stop 3D panels re-rendering and resetting the camera on every data refresh

  The Babylon 3D analytics panels rebuilt their entire engine/scene on every
  data update, which flickered ("Rendering…") and snapped the user's orbit
  camera back to its default framing several times per second on the live
  demo/session views. Each view now initializes the scene **once** and repaints
  only the data-driven content in place — the camera is framed a single time at
  build and is never reset by a live refresh.

  - @uptimizr/react: split the single data-keyed effect in every 3D view
    (`WorldHeatmap3D`, `CameraDome3D`, `ClickRays3D`, `GazeClickDivergence3D`,
    `FlowSankey3D`) into a lifecycle effect (engine/scene/camera/lights, framed
    once) plus an in-place data-sync effect that repaints thin-instance buffers /
    content meshes without touching the camera. Latest data is read through refs;
    the faint proxy backdrop is rebuilt only when the scene geometry actually
    changes.
  - @uptimizr/react: fix `MeshUvHeatmap` (2D) flicker — keep the last rendered
    canvas on screen during a background refetch instead of swapping in a
    "Loading…" placeholder every refresh.
  - @uptimizr/dashboard: refresh live-session panels while a session drill-down is
    open so their data updates in real time instead of only after navigating away
    and back.

## 0.8.0

### Minor Changes

- 4751b5d: feat: path-retrace / backtracking-ratio leaderboard (#153). Adds a new derived
  metric — computed from the existing `camera_sample` position stream, with **no
  schema change** — that ranks scenes/areas by how often visitors re-walk the same
  area (a confusion signal desire lines don't surface).

  - `@uptimizr/db`: new `buildBacktrackRatio(projectId, opts, dialect)` aggregation
    and `BacktrackRatioRow` type. It bins positions onto a coarse X/Z grid
    (`cellSize`, default 2 world units), collapses consecutive dwell samples in one
    cell into ordered _cell entries_ via the `asofLeftJoin` predecessor pattern, and
    pools `backtrack_ratio = revisits ÷ entries` per scene. Cross-engine safe
    (DuckDB + ClickHouse): uses only plain `count()` + a distinct-cell dedup
    subquery and the `present` sentinel for ASOF-LEFT misses. Added to the parity
    suite with golden output.
  - `@uptimizr/collector-server`: new `GET /api/v1/backtrack` query route
    (`cellSize`, `limit`, `scene`, `session`) plus the `backtrackRatio` store method
    across the DuckDB, ClickHouse, and memory stores.
  - `@uptimizr/react`: new `backtrackRatio()` API client method, `BacktrackRatioStat`
    type, and a **Backtracking hotspots** leaderboard panel (`backtrack-ratio`)
    registered in `ossPanelCatalog` and exported individually.

  Additive and non-breaking — every existing export keeps working.

- e39cbc7: feat: optional `position` on `runtime_error` / `graphics_diagnostic` + spatial error heatmap (#154)

  Add an optional, best-effort `position` (`[x, y, z]`, the camera pose at the moment the event
  fired) to the `runtime_error` and `graphics_diagnostic` events. The Babylon connector stamps it
  automatically from the tracked camera; `sdk-core` gains a `setPositionProvider` seam so any connector
  can supply one, and enrichment happens centrally in `emitInternal` (before `beforeSend`, so it stays
  redactable). The field is additive and backward-compatible — older events simply omit it, and it
  reuses the already-promoted `position` column (no migration).

  On the read side, `@uptimizr/db` adds `buildErrorHeatmap` (voxel-bins positioned errors +
  diagnostics, with optional `severity`/`category`/`errorKind` filters), surfaced via the collector's
  new `GET /api/v1/heatmaps/errors` endpoint and a new **Error heatmap (3D)** dashboard panel
  (`@uptimizr/react`) reusing the world-heatmap view — revealing _where_ in the scene things break,
  not just _when_.

- 3c0a20b: feat(perf): add optional `position` to `frame_perf` + spatial FPS heatmap (#145)

  `frame_perf` samples can now carry the camera world-`position` at the moment
  they're taken, so the collector can show _where_ FPS drops, not just _when_. The
  Babylon connector fills it automatically from the tracked camera; other
  connectors may set it on the emitted event.

  - **schema**: `frame_perf.position` is an optional `vec3` (additive,
    backward-compatible — events still validate without it).
  - **sdk-core / babylon**: the perf snapshot threads an optional `position`
    through the aggregator into the emitted event; Babylon reads the tracked camera.
  - **db**: new dialect-agnostic `buildPerfHeatmap` voxel builder
    (`samples`/`avg_fps`/`min_fps`, ordered `avg_fps ASC`). Reuses the promoted
    `position` column — **no migration**.
  - **react**: new `perfHeatmap()` client method + **Performance heatmap (3D)**
    panel (reuses the world-heatmap renderer; hot = slow, honest per-voxel FPS on
    hover).

  The collector exposes it at `GET /api/v1/heatmaps/perf`.

- db331a3: feat: load → bounce/abandon funnel (#152). Adds a `buildLoadBounceFunnel` query
  builder that buckets sessions by their initial `asset_load` time band and counts
  how many bounced (no `pointer_*` / `mesh_interaction` / `camera_gesture` after
  load), a `GET /api/v1/load-bounce` collector endpoint, an `api.loadBounce()` client
  method, and a "Load → bounce funnel" dashboard panel. Derived from existing events —
  no schema change.
- de0836d: feat: blind-spot / never-noticed mesh report (#143)

  Add a "blind spots" leaderboard — the inverse of the most-interacted / part-
  popularity panels — surfacing meshes that render but are never noticed. A new
  `@uptimizr/db` aggregation (`buildMeshBlindSpots`) cross-references
  `mesh_visibility` on-screen time against `mesh_interaction` + `hover_dwell`
  engagement per mesh, keeping only meshes that were actually visible and ranking
  the most-seen-yet-least-touched first. Exposed through the collector's
  `GET /api/v1/meshes/blind-spots` endpoint and a new **Blind spots** panel in
  `@uptimizr/react`'s `ossPanelCatalog` (`meshBlindSpots` API client +
  `BlindSpotReportView`). No schema change — reuses the existing event types.

- 3193a21: feat: add optional `uv` field for a per-mesh texture-space heatmap (#149)

  `pointer_click`, `mesh_interaction`, and `hover_dwell` now carry an optional,
  unclamped `uv: [u, v]` texture coordinate, captured by the Babylon connector from
  the raycast hit (`PickingInfo.getTextureCoordinates()`). It rides in the event
  `payload` — additive and backward-compatible, no column promotion or migration.

  A new `buildMeshUvHeatmap` query builder and `GET /api/v1/heatmaps/mesh-uv`
  endpoint bin a single mesh's `uv` values into a grid, surfaced by the dashboard's
  new **Mesh UV heatmap** panel (interactive mesh picker, defaults to the
  most-interacted mesh).

- 541c97a: feat(perf): perf-driven churn overlay — correlate FPS dips / compile stalls with early session end (#144)

  Adds a buildable-now "perf-correlated churn rate": of the sessions that ended in
  range, the share that ended shortly after an FPS dip (a `frame_perf` sample below
  a threshold) or a `compile_stall`, within a configurable window, split by cause.

  - `@uptimizr/db`: new dialect-agnostic `buildPerfChurn` aggregation (`PerfChurnRow`)
    derived from existing `frame_perf`, `compile_stall`, `session_end` events — no
    schema change; DuckDB + ClickHouse safe (no window/ASOF functions).
  - `@uptimizr/collector-server`: new `GET /api/v1/perf/churn` endpoint
    (`windowMs` / `fpsThreshold` / `stallMs` params) and `Store.perfChurn`.
  - `@uptimizr/react`: `CollectorApi.perfChurn` + the "Perf-driven churn" dashboard
    panel with viewer-tunable window / FPS / stall settings.

- 31ae82b: feat(db,collector,react): reachability report — per-mesh interaction-distance histogram (#151)

  Adds a buildable-now `buildReachability` query that ASOF-joins each `mesh_interaction`
  world point to the nearest preceding `camera_sample` and histograms the standpoint→interaction
  distance per mesh, surfaced through `GET /api/v1/meshes/reachability`, the `@uptimizr/react`
  client, and a new **Reachability report** OSS panel. No schema change.

- 53a4695: feat: add a canned scene/level retention funnel (#147)

  A zero-config Sankey preset built directly from `scene_change` markers — session
  counts flowing scene → scene in observed order, weighted by distinct sessions, so
  level-to-level drop-off is visible without authoring any funnel steps (the
  complement to the caller-authored funnel, ADR 0038).

  - `@uptimizr/db`: new `buildSceneRetention()` query builder (parity-safe — no
    window functions) plus `SceneRetentionOptions` / `SceneRetentionRow` types.
  - `@uptimizr/react`: new `CollectorApi.sceneRetention()` + `SceneRetentionLink`
    type, and a built-in **Scene retention funnel** panel in the OSS catalog.

  Served by the collector at `GET /api/v1/scene-retention`.

- b0ac76e: feat(db,react): variant → conversion leaderboard for product configurators (#150)

  Add a read-only leaderboard that ranks `custom` variant events (grouped by their
  `name`) by views, with distinct sessions, mean dwell before the next variant
  switch/conversion, and an optional per-variant conversion rate to a caller-supplied
  success event. Reuses the ADR 0038 funnel-step predicate shape — no schema change.

  - `@uptimizr/db`: `buildVariantLeaderboard` query builder (`VariantLeaderboardOptions`
    / `VariantLeaderboardRow`), engine-agnostic so DuckDB and ClickHouse match.
  - `@uptimizr/react`: `CollectorApi.variantLeaderboard()` client method and a new
    `variant-leaderboard` dashboard panel with an in-panel success-event picker.

  Also wires the `GET /api/v1/variant-leaderboard` endpoint through the collector
  server (store contract + DuckDB / ClickHouse / memory stores).

- ab4e3c5: feat(dashboard,db): 360° view-coverage gauge per session (#146)

  Add a derived per-session **view-coverage** metric: bin each session's
  `camera_sample` directions into the same azimuth/elevation grid as the
  view-direction dome, and report the fraction of cells visited as a 0–100%
  coverage score. Sessions are aggregated into a histogram of 25%-wide coverage
  bands (0–25 / 25–50 / 50–75 / 75–100%) — "how many visitors never rotated the
  product to see the back".

  - `@uptimizr/db`: new `buildViewCoverageHistogram` query builder + `ViewCoverageHistogramRow`.
  - `@uptimizr/collector-server`: new `GET /api/v1/coverage/view-histogram` read endpoint.
  - `@uptimizr/react`: new `viewCoverageHistogram` API client method and the **View coverage**
    dashboard panel.

  No schema change — entirely derived from the existing `camera_sample` stream.

- 872d4b2: feat(dashboard): VR comfort & locomotion panel (#148)

  Add an XR-focused locomotion + comfort panel that reuses existing schema (no
  schema change). A new `@uptimizr/db` `buildXrLocomotionComfort` builder returns,
  per XR session, its fly/navigate gesture counts, `mesh_interaction` teleport
  count, total locomotion duration, and wall-clock span. The `@uptimizr/react`
  catalog gains an `xrLocomotionComfortPanel` that renders the locomotion-style mix
  (teleport vs. smooth locomotion vs. navigate) and a heavy-vs-light-locomotion
  early-exit correlation — a motion-discomfort proxy. Exposed via
  `GET /api/v1/xr/locomotion`.

## 0.7.0

### Minor Changes

- dc740f3: feat(react): make `@uptimizr/react` the single source of truth for the OSS
  dashboard's analytics panels (ADR 0047, serving the downstream consumer's
  ADR 0052). The package now exports `ossPanelCatalog` — the complete, portable
  set of built-in panels — so a downstream host can enumerate and render the
  entire OSS panel catalog from the package alone. Every catalog panel is also
  exported individually (`topMeshesPanel`, `worldHeatmapPanel`, `flowPanel`, …),
  along with the panel view components (`TopMeshesView`, `FloorPlanHeatmapView`,
  …) and their 3D/canvas helper libs (`mergeSceneProxies`, `disableWheelZoom`,
  `attachMeshHover`, `buildTwoStageGraph`, …).

  Babylon.js stays optional: `@babylonjs/core` is an **optional** peer dependency,
  and the Babylon-backed 3D panels keep their view code behind `React.lazy` inside
  the catalog, so importing `ossPanelCatalog` never loads `@babylonjs/*` at
  module-eval time. The core entry stays `sideEffects: false` and Babylon-free. A
  new `@uptimizr/react/panels-3d` subpath exposes the 3D view components for
  direct, opt-in composition outside the catalog.

  Additive and non-breaking — every existing export keeps working and the panel
  contract version is unchanged. The standalone dashboard is refactored to a thin
  consumer of `ossPanelCatalog`.

## 0.6.0

### Minor Changes

- a580f5e: Surface opt-in engine diagnostics in the dashboard (#16, ADR 0021 part 2). Adds a
  dialect-agnostic `buildGraphicsDiagnosticCounts(projectId, opts, dialect)` aggregation to
  `@uptimizr/db` that rolls `graphics_diagnostic` events up into `(severity, category, backend)`
  incident counts, folding discrete markers (no `count`) and per-session rollups (`count: N`)
  honestly as `SUM(COALESCE(count, 1))`. The fields ride in stored JSON (nothing promoted to a
  column), so extraction goes through the existing `jsonText` helper plus a new nullable
  `Dialect.jsonInt(column, ...path)` so the `count` cast stays identical across DuckDB and
  ClickHouse (covered by a `PARITY_CASES` entry).

  `@uptimizr/react` gains a `graphicsDiagnosticCounts()` query-client method (and
  `GraphicsDiagnosticCount` type) hitting the new `GET /api/v1/graphics-diagnostics` collector
  endpoint. Capture is off by default, so the new dashboard "Engine diagnostics" panel shows an
  explicit opt-in empty state until `captureGraphicsDiagnostics` is enabled.

- c8887f7: Surface the always-on rendering-technology mix in the dashboard (#120, ADR 0021 part 1). Adds a
  dialect-agnostic `buildRenderingTechnology(projectId, opts, dialect)` aggregation to `@uptimizr/db`
  that rolls `session_start.graphics` up into `(api, backend, api_version, shading_language)` session
  counts. The fields ride in stored JSON (nothing promoted to a column), so extraction goes through the
  existing `jsonText` helper and blanks coalesce to `''` ("unknown"), covered by a `PARITY_CASES`
  entry. Unlike the opt-in engine-diagnostics rollup this is always-on, so a populated result is the
  common case.

  `@uptimizr/react` gains a `renderingTechnology()` query-client method (and `RenderingTechnologyCount`
  type) hitting the new `GET /api/v1/rendering-technology` collector endpoint, powering the new
  dashboard "Rendering technology" panel beside Engine diagnostics — sessions broken down by API,
  backend, and shading language with no opt-in empty state.

## 0.5.0

### Minor Changes

- fa6c472: Add a browser/OS performance segment derived from the request User-Agent at
  ingestion (#11). The collector reduces the User-Agent to a coarse, non-PII
  `{ browser, os }` pair (raw UA never stored) and merges it into
  `session_start.device`; `buildPerfByDevice` and the dashboard "FPS by device"
  panel now segment per-session median FPS by browser/OS in addition to graphics
  backend, mobile flag, and GPU renderer. No SDK, schema-capture, or storage
  migration change (ADR 0041).
- ad8addf: feat(dashboard): runtime/remote panel loading (#61)

  The dashboard can now discover and load panels from a remote manifest at runtime — behind the same
  `PanelDefinition` contract — so self-hosters add panels without rebuilding. `@uptimizr/react` gains
  `PANEL_CONTRACT_VERSION` and a framework-agnostic loader (`fetchPanelManifest`, `loadRemotePanels`,
  `mergePanels`, plus manifest/definition guards) with contract-version gating, an optional origin
  allowlist, and per-entry error isolation. The dashboard reads `NEXT_PUBLIC_PANELS_MANIFEST_URL`
  (and optional `NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS`), merges remote panels with the built-ins,
  surfaces load failures in a banner, and hardens `PanelHost` with a guarded `enabled()` and a
  per-panel render error boundary so a misbehaving panel never breaks the grid. Off by default;
  build-time registration is unchanged.

## 0.4.0

### Minor Changes

- 69a80a9: feat(dashboard): viewer-configurable panels — hide/show with restore plus typed per-panel settings (#79)

  Panels can now be hidden and restored (always reversible, viewer-local) and expose typed settings
  (`number`/`boolean`/`select`) via a generic `PanelDefinition`/`PanelContext` contract. Settings are
  resolved with declared defaults overlaid by saved overrides through a swappable `PanelStateStore`
  seam, and `usePanelData` refetches on settings change. Built-in data-resolution settings ship for
  the floor-plan, view-direction dome, world/voxel heatmap, pointer heatmap, click flow, and top-meshes
  panels.

- b5c7eac: feat(heatmaps): large-scene spatial resolution (ADR 0040)

  Make scenes that are much larger than their walkable area legible without forcing manual
  `setScene` segmentation. Four additive, non-breaking pillars:

  - **Bounds-driven `cellSize`** — `@uptimizr/db` gains `defaultCellSizeForBounds(bounds, targetCells)`;
    the collector's world/gaze heatmaps derive a sensible voxel size from the selected scene's
    registered world bounds (ADR 0014) — or a `region` box — when `cellSize` is omitted, so big
    scenes no longer collapse into a few coarse blocks. An explicit `cellSize` still wins.
  - **Robust normalization** — `@uptimizr/react` exports `percentileMax(counts, p=0.95)`; the
    dashboard's 3D world heatmap normalizes color/size to the 95th-percentile cell so a couple of
    hotspots no longer wash out the rest of the scene.
  - **Totals + cold-spots** — new `buildWorldHeatmapStats`/`buildGazeHeatmapStats` builders, store
    methods, and `GET /api/v1/heatmaps/{world,gaze}/stats` routes returning `{ cellSize, cells, hits }`
    (the true occupied-cell + hit counts behind the truncated top-N voxels); the world panel surfaces
    coverage in its legend.
  - **Region (AABB) drill-down** — a `region=minX,minY,minZ,maxX,maxY,maxZ` filter (and matching
    `RegionOptions`/`regionClause` in `@uptimizr/db`, `region` in the `@uptimizr/react` client) scopes
    world/gaze/position heatmaps to an axis-aligned box for semantic zoom.

  Existing heatmap response shapes are unchanged; the stats endpoints and `region`/auto-`cellSize`
  behavior are all additive.

## 0.3.0

### Minor Changes

- 9e22ebd: feat: caller-configured conversion-funnel aggregation (#78).

  Implements sub-issue (b) of the funnel epic in OSS. Authoring, persistence, and the
  saved-funnel dashboard panel remain hosted-only — the OSS dashboard stays a passive
  viewer (ADR 0038).

  - `@uptimizr/schema`: shared funnel contract — `funnelStepSchema`, `funnelStepsSchema`
    (2–20 steps), `funnelConfigSchema`, and `FUNNEL_CONFIG_VERSION`.
  - `@uptimizr/db`: new dialect-agnostic builder `buildFunnel` — a dynamic-N CTE chain
    using only `JOIN`/`min`/`GROUP BY` (no window or `ASOF` functions) so DuckDB and
    ClickHouse render identically (golden parity coverage on DuckDB). Semantics are
    sequential, first-touch, and monotonic.
  - `@uptimizr/collector-server`: new read endpoint `GET /api/v1/funnel`, wired through
    every store. The funnel definition is supplied per request as a `steps` JSON array
    (validated against `funnelStepsSchema`) and never stored.
  - `@uptimizr/react`: new client method `funnel(steps, params?)`.

- 605abf8: feat: add three more built-in dashboard panels via the ADR 0036 panel contract.

  - **Navigation-style mix** (`navigation-mix`, #69): a half-width breakdown of camera-gesture
    kinds (orbit / pan / dolly / zoom / roll / fly) with per-kind share and average gesture
    duration. Backed by a new `CollectorApi.cameraGestures()` client method on `@uptimizr/react`
    over the existing `/api/v1/camera-gestures` endpoint.
  - **Flow Sankey (3D)** (`flow-sankey-3d`, #68): the direction-bin → mesh (and standpoint → gaze
    → mesh) flow renderer is now a full-width, client-only `PanelDefinition`; the panel owns its
    walk/orbit/all camera-mode toggle, so the base query drops the global camera-mode filter.
  - **Gaze vs. click divergence** (`gaze-click-divergence-3d`, #70): a full-width, client-only
    overlay of world-space gaze voxels (cool) against click voxels (warm) at a shared cell size,
    with overlay / gaze / click / divergence view modes.

- 394d5c8: feat: add render-scale truth, mesh interaction-kind, and aggregate desire-line analytics
  (#71, #72, #73).

  - `@uptimizr/db`: new dialect-agnostic builders `buildRenderScaleTruth`, `buildMeshInteractionKinds`,
    and `buildAggregateTrajectories` (with golden parity coverage on DuckDB).
  - `@uptimizr/collector-server`: new read endpoints `GET /api/v1/perf/render-scale`,
    `GET /api/v1/meshes/kinds`, and `GET /api/v1/paths`, wired through every store.
  - `@uptimizr/react`: new client methods `renderScale()` (derives `downscaled_share`), `meshKinds()`,
    and `aggregatePaths()`.
  - `@uptimizr/dashboard`: new built-in panels — Render-scale truth, Mesh interaction kinds, and
    Desire lines (ADR 0037, overview-only, gated to walkable sessions).

- e5ce02c: feat: add part-popularity, input-modality, dead-zone, and performance-distribution panels
  (#74, #75, #76, #77).

  - `@uptimizr/db`: new dialect-agnostic builders `buildTopMeshesBySource`, `buildTopMeshesTrend`,
    and `buildTopInputActions` (with golden parity coverage on DuckDB). `buildTopMeshesBySource` and
    `buildTopMeshesTrend` are scoped to **active** interactions (`mesh_interaction` + `pointer_click`),
    so passive gaze does not inflate part popularity — a deliberate divergence from `buildTopMeshes`.
    `input_action.action` is now threaded into the engine-neutral `name` column so it is queryable.
  - `@uptimizr/collector-server`: new read endpoints `GET /api/v1/meshes/sources`,
    `GET /api/v1/meshes/trend`, and `GET /api/v1/input-actions/top`, wired through every store.
  - `@uptimizr/react`: new client methods `topMeshesBySource()`, `topMeshesTrend()`, and
    `topInputActions()`.
  - `@uptimizr/dashboard`: four new built-in panels — Part-popularity leaderboard (#74, ranked meshes
    with a trend sparkline + per-mesh input-source split), Input-modality split (#75, per-source share
    - most-used shortcuts), Dead-zone report (#76, client-side intersection of scene coverage with the
      registered proxy, with an empty-state when no proxy is registered), and Performance distribution
      (#77, p05/p50/p95 FPS bands + per-session median-FPS histogram reusing the existing reads).

## 0.2.0

### Minor Changes

- 8f14077: feat(react): add the extensible dashboard panel contract — `PanelDefinition`, `PanelContext`, `definePanel`, and `usePanelData`, plus shared filter (`FilterState`, `toQueryParams`, …) and `LiveEvent` helpers — so the dashboard and embeds can register custom panels (ADR 0036)

## 0.1.1

### Patch Changes

- df5b66b: chore: point each package's npm `homepage` at its specific docs page (instead of the GitHub tree URL) and add an `author` field across the public manifests.

## 0.1.0

### Minor Changes

- b2b7b44: Initial public release of Uptimizr — open-source, privacy-first analytics for 3D scenes.

  This first `0.1.0` ships the full open-source data collector: the `@uptimizr/schema` event
  contracts, the `@uptimizr/sdk-core` runtime, engine connectors (`@uptimizr/babylon`,
  `@uptimizr/babylon-lite`, `@uptimizr/three`, `@uptimizr/r3f`, `@uptimizr/aframe`,
  `@uptimizr/playcanvas`, `@uptimizr/react`), session `@uptimizr/replay`, the `@uptimizr/heatmap`
  renderer, the embedded-store `@uptimizr/db` layer, the `@uptimizr/mcp` server, and the
  `@uptimizr/collector-server` ingestion/query API plus the `@uptimizr/dashboard`.
