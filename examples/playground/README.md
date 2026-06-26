# Uptimizr Playground

One playground app that serves **all five engine connectors** from a single Vite
build. Pick a **scene** and an **engine** from the selectors in the top-left panel;
the app reloads with `?scene=<id>&engine=<id>` and **dynamic-imports only that
engine's chunk** (so switching to three never downloads Babylon, and vice-versa).

## Scenes

The playground is **scene-first**: a committed catalog
([`scenes.json`](./scenes.json)) lists every buildable scene, each with its fixed
camera mode, its allowed engines, and a default engine. The **Scene** selector
reloads with `?scene=<id>`; the **Engine** selector is constrained to that scene's
engines (and is hidden when a scene is bound to a single engine).

Built-in scenes:

| Scene    | id         | Camera mode    | Engines                                               |
| -------- | ---------- | -------------- | ----------------------------------------------------- |
| Lobby    | `lobby`    | viewer (orbit) | babylon, babylon-lite, three, playcanvas, r3f, aframe |
| Atrium   | `atrium`   | first-person   | babylon, three, playcanvas                            |
| Showcase | `showcase` | viewer (orbit) | babylon, three, playcanvas                            |
| Gallery  | `gallery`  | first-person   | babylon, three, playcanvas                            |
| Expanse  | `expanse`  | first-person   | babylon, three, playcanvas                            |

`lobby` and `atrium` are synthetic demo scenes (procedural boxes / a room).
**`showcase` and `gallery` load real glTF models** to exercise the connectors
against production-like assets:

- **Showcase** — an orbit/viewer camera framing a single real glTF model (Khronos
  `ToyCar`), for inspecting a detailed PBR asset.
- **Gallery** — a first-person walkable room with three real glTF models (Khronos
  `ToyCar`, `Fox`, `GlamVelvetSofa`) on pedestals; walk up and pick the exhibits.
- **Expanse** — a deliberately **large** (~360 × 560 world units, ≈10× the atrium),
  walkable, **multi-level** world built to exercise large-scene analytics
  ([ADR 0040](../../docs/adr/0040-large-scene-spatial-resolution.md)). It has real
  vertical traversal — a ramp up to a raised overlook terrace and a three-floor
  tower joined by internal ramps — with landmarks scattered far apart and an
  out-of-the-way "gardens" corner that stays cold unless sought out (so coverage /
  cold-spot signals are meaningful). Walking between areas **auto-switches the
  tracked `scene_id`** via `setScene` (plaza → ramp → overlook → tower floors →
  gardens; ADR 0040 §5), so one continuous space is captured as distinct, named
  sub-areas you can filter and segment on — and its registered (large) bounds drive
  a coarse default voxel size (§1). A hands-on test bed for the bounds-driven cell
  size, region drill-down, and coverage features. Built for **Babylon, three.js and
  PlayCanvas**: the three connectors share one layout (`src/scenes/expanse/layout.ts`
  — geometry, an analytic floor-height field the first-person controller samples to
  climb the ramp/overlook/tower, and the section boxes), so every engine walks the
  same multi-level world and exercises the identical large-scene path.

Both reuse the same shared connector wiring as the demo scenes via each engine's
`create<Engine>EngineModule` factory — only the model loading/placement is custom
(under `src/scenes/<id>/<engine>.ts`). The models are vendored under
[`public/models/`](./public/models) with sources and licenses recorded in
[`public/models/ATTRIBUTION.md`](./public/models/ATTRIBUTION.md).

A scene fixes its camera mode and is bound to **one collector project** (so each
scene's analytics stay separate). For back-compat, `?camera=viewer|first-person`
(with no `?scene=`) still selects the matching built-in scene.

### Add a scene

```bash
pnpm scene:new "Showroom"                          # viewer, babylon
pnpm scene:new "Showroom" --engines babylon,three  # viewer, multiple engines
pnpm scene:new "Office" --camera first-person --engines babylon,three
```

This mints a dedicated collector project (one per scene), appends the scene to
[`scenes.json`](./scenes.json), records the scene→project binding in the local
gitignored registry (`.uptimizr/projects.json`, read by the dashboard and the
playground), and scaffolds a per-engine builder stub under
`src/scenes/<id>/<engine>.{ts,tsx}`. The stubs initially re-export the built-in
engine demo so analytics flow immediately — edit them to build your own geometry.

| Engine            | id           | Capture | Scene switch | Replay | Heatmap | Scene proxy | Walkable |
| ----------------- | ------------ | :-----: | :----------: | :----: | :-----: | :---------: | :------: |
| Babylon.js        | `babylon`    |   ✅    |      ✅      |   ✅   |   ✅    |     ✅      |    ✅    |
| three.js          | `three`      |   ✅    |      ✅      |   ✅   |    —    |     ✅      |    ✅    |
| PlayCanvas        | `playcanvas` |   ✅    |      ✅      |   ✅   |    —    |     ✅      |    ✅    |
| react-three-fiber | `r3f`        |   ✅    |      —       |   —    |    —    |      —      |    —     |
| A-Frame (WebXR)   | `aframe`     |  (own)  |      —       |   —    |    —    |      —      |    —     |

The **top bar** holds the primary navigation — the Scene and Engine selectors —
always visible, plus a **Controls** button that toggles the side panel. The panel
**starts collapsed** (every signal is captured by default, so there is rarely
anything to touch, and on phones it would otherwise cover the scene); the choice
persists per browser. When opened it is intentionally compact: a collapsible
**Session & scene** section (project/session ids, the read-only camera mode, the
lobby/gallery sub-area switcher, sampling + input-source readouts) and a collapsible
**Capture** section (one checkbox per recorded signal), followed by the replay /
heatmap / scene-proxy controls.

The shared **shell** (`src/shell.ts`) owns every piece of UI — scene + engine
selectors, connection indicator, delivery-confirming transport, capture-toggle
panel, scene switcher, input-source readout, cursor overlay, and the replay /
heatmap / scene-proxy controls. Each engine module under `src/engines/` owns only
the engine-specific parts (building the demo scene, starting its real connector,
picking, flashing, and the replay/proxy glue) and declares its `EngineCapabilities`
so the shell shows only the controls that engine supports. The contract lives in
`src/engine.ts`.

A-Frame is the declarative special case: it is loaded from its official CDN and
captures through the `uptimizr` component, so it has no imperative client — only the
connection indicator and status line apply.

### Camera modes — viewer vs. first-person (ADR 0026)

The camera/navigation model is **fixed by the scene**, not separately selectable —
you switch it by choosing a different scene. The panel shows the active mode as a
read-only indicator:

- **Viewer (orbit)** — the `lobby` / `showcase` scenes: an arc-rotate camera framing
  a model (`cameraType: "arc-rotate"`).
- **First-person (walk)** — the `atrium` / `gallery` / `expanse` scenes: a larger **walkable**
  space (room, walls, item pedestals, an ambient NPC; or, for `expanse`, a large multi-level
  world) traversed with **WASD** (Babylon) or pointer-lock + WASD (three / PlayCanvas), using a
  free camera (`cameraType: "free"`).

For back-compat, `?camera=viewer|first-person` (with no `?scene=`) still selects the
matching built-in scene. First-person scenes drive the dashboard's floor-plan
position heatmap and per-session walked-path view.

## Run

```bash
# From the repo root (shares the root .env for VITE_* vars):
pnpm --filter @uptimizr/example-playground dev
# or
pnpm dev:playground
```

Configure via the repo-root `.env` (all optional for local dev):

- `VITE_COLLECTOR_URL` — collector base URL (default `http://localhost:4318`)
- `VITE_PROJECT_ID` — viewer (arc-rotate) project id (default `demo`)
- `VITE_API_KEY` — viewer API key; required for replay, heatmap, and scene-proxy controls
- `VITE_PROJECT_ID_WALKABLE` / `VITE_API_KEY_WALKABLE` — the **first-person** (walkable)
  project. Viewer and first-person sessions are tracked as separate projects (ADR 0026), so the
  playground sends each camera mode to its own project. Falls back to the viewer project when
  unset. `pnpm db:seed` provisions both.

## End-to-end tests

```bash
pnpm --filter @uptimizr/example-playground test:e2e:install   # once
pnpm build                                                    # compile workspace packages
pnpm --filter @uptimizr/example-playground test:e2e
```

### Watch it run in a real browser

```bash
# Headed: opens a visible Chromium and runs the suite in it.
pnpm --filter @uptimizr/example-playground test:e2e:headed

# Headed + slowed down so each action is easy to follow (ms per action):
E2E_SLOWMO=250 pnpm --filter @uptimizr/example-playground test:e2e:headed

# Interactive Playwright UI (pick/replay individual tests, time-travel):
pnpm --filter @uptimizr/example-playground test:e2e:ui

# Watch a single engine / spec — use the `exec playwright` form so extra flags
# (`--headed`, `--grep`, a file path, …) pass straight through:
E2E_SLOWMO=250 pnpm --filter @uptimizr/example-playground \
  exec playwright test --headed --grep babylon e2e/engines.capture.spec.ts
```

> `E2E_SLOWMO` (milliseconds per browser action) is honoured in any mode and is a
> good companion to `--headed`. It's `0` (full speed) by default. For the smoothest
> watch, target one test at a time — running the whole suite headed is heavier and
> can flake on a busy machine.

The Playwright harness runs against the **DuckDB single-file store** (ADR 0020),
not the in-memory store, so the collector's analytics aggregations (top meshes,
perf, input-source breakdown, heatmaps, …) have real data to query and render.
`e2e/seed.ts` provisions a throwaway DuckDB file (`e2e/.tmp/e2e.duckdb`) with a
deterministic project + API key, then the collector boots against it — DuckDB is
single-writer, so the seed runs-and-closes before the server opens the file
(chained with `&&` in the webServer command). Playwright launches three servers:
the collector, the Vite playground, and the Next.js dashboard.

Three specs cover the stack:

- **`engines.capture.spec.ts`** — the exhaustive capture matrix. For each WebGL
  connector (`babylon`, `three`, `playcanvas`) it synthesizes the full non-WebXR
  interaction set (pointer move/down/up/click, mesh pick, orbit gesture, wheel,
  scene switch, keyboard, resize, and a real `WEBGL_lose_context` loss/restore)
  and asserts every event type round-trips through the collector into DuckDB,
  including `camera_gesture`, `scene_change`, `context_lost`, and Babylon's
  keyboard `input_action`. It also asserts the dashboard's aggregation endpoints
  (`/api/v1/event-counts`, `/api/v1/interactions/sources`) reflect the session.
- **`dashboard.spec.ts`** — drives a rich Babylon session, then opens the Next.js
  dashboard pointed at the same collector and asserts the panels render the
  captured analytics (top meshes, input-source breakdown, perf) and that the
  session appears in the sessions table and opens its drill-down.
- **`playground.spec.ts`** — the original capture → collector → replay round-trip
  per WebGL engine, plus a boot smoke test for `r3f` and a first-person walkable
  session (ADR 0026): it walks a Babylon free camera with WASD and asserts the
  `cameraType: "free"` label, the floor-plan position heatmap, the session's
  walked-path trajectory, and that the camera-mode filter lists it under
  first-person but not viewer.
- **`large-scene.spec.ts` / `expanse.spec.ts`** — the large-scene path (ADR 0040).
  `large-scene` drives a Babylon session and exercises the world-heatmap **stats**
  (true cell/hit totals behind the truncated voxel list), **region** AABB
  drill-down, and a derived `cellSize`. `expanse` boots the large multi-level
  **Expanse** scene **on each engine that builds it (Babylon, three.js, PlayCanvas)**
  and asserts its section auto-switching (the spawn tracks as `expanse-plaza`) and
  that its registered large bounds drive a **coarse** bounds-driven cell size when
  `cellSize` is omitted.

WebXR / immersive events are intentionally out of scope.
