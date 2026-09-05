# `examples/unity-web-export` — sample Unity WebGL project

A minimal **Unity 2022.3 LTS** project wired to the
[`@uptimizr/unity`](../../oss/packages/unity) engine-side bridge (ADR 0045). It exists so
verifying the **bridged capture tier** against a real WebGL export is **one manual
step** (a Unity build) instead of a hand-driven session — the Playwright spec
`examples/playground/e2e/unity-export.spec.ts` serves the build, boots the real
connector, clicks the scene, and asserts the bridged channels reach the collector.

Unity is not installed in CI, so the spec **skips cleanly** when no build is present
and only runs for a maintainer who has built the project locally (#253).

## What's in the project

| Path                                        | What it is                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Assets/Scenes/Sample.unity`                | One scene: a `Main Camera` at `(0, 1, -6)` looking down +Z, a directional light, and three named cubes.    |
| `Assets/Uptimizr/UptimizrUnityBridge.cs`    | **Copy** of the package's `MonoBehaviour`, attached to the `Uptimizr` GameObject with `Main Camera` bound. |
| `Assets/Plugins/WebGL/Uptimizr.jslib`       | **Copy** of the package's Emscripten plugin (Unity compiles `Plugins/WebGL/*.jslib` into the export).      |
| `Packages/manifest.json`                    | Built-in modules only (physics, UI, …) — no store packages, nothing to download.                           |
| `ProjectSettings/ProjectVersion.txt`        | Pins the editor line (`2022.3.x`); any 2022.3 LTS works, Unity Hub offers to switch.                       |
| `ProjectSettings/EditorBuildSettings.asset` | Puts `Sample.unity` in the build so **Build** needs no scene wrangling.                                    |
| `ProjectSettings/ProjectSettings.asset`     | Player settings: **Compression Format: Disabled**, run in background, 960×600 default canvas.              |

The cubes have `BoxCollider`s so the bridge's pick raycast hits them:

- `CenterCube` at `(0, 1, 0)` — straight ahead of the camera; a click at the **centre
  of the canvas** hits its front face (`z ≈ -0.5`).
- `LeftCube` at `(-2.5, 1, 0)` and `RightCube` at `(2.5, 1, 0)`.

### Bridge files are copies — keep them in sync

`UptimizrUnityBridge.cs` and `Uptimizr.jslib` are byte-for-byte copies of
[`oss/packages/unity/bridge/`](../../oss/packages/unity/bridge) (Unity needs them inside
the project tree). `pnpm lint` runs `scripts/check-bridge-sync.mjs`, which **fails when
the copies drift** from the source. After editing the bridge in the package, re-sync:

```bash
pnpm --filter @uptimizr/example-unity-web-export sync-bridge
```

## The one manual step: build it

1. Open **Unity Hub** → **Add** → pick this folder (`examples/unity-web-export`). Use any
   **2022.3 LTS** editor with the **WebGL Build Support** module installed.
2. Open the project, then **File → Build Settings…** → select **WebGL** → **Switch
   Platform** (first time only) → **Build**.
3. Choose **`examples/unity-web-export/dist/`** as the output folder (it is
   git-ignored). Unity writes `dist/Build/dist.loader.js`, `dist.data`,
   `dist.framework.js`, `dist.wasm`, plus `dist/index.html` and `dist/TemplateData/`.

That's it. The Playwright spec finds `dist/Build/*.loader.js` and stops skipping.

### Build settings that matter

- **Compression Format: Disabled** (Edit → Project Settings → Player → WebGL →
  Publishing Settings). `ProjectSettings.asset` pre-sets this. With it, the output serves
  from any **plain static server** — no `Content-Encoding` headers, no `.gz`/`.br`
  MIME configuration. (The playground's dev-server middleware does also serve
  gzip/brotli outputs with the right `Content-Encoding`, but Disabled is the
  zero-config path and what the docs assume.)
- **WebGL template.** The spec **does not use** Unity's generated `index.html` — the
  harness page (`examples/playground/unity-export-e2e.html`) loads
  `Build/*.loader.js` itself and calls `createUnityInstance` **after** starting the
  connector, so `window.__uptimizr_unity__` exists when the C# `Start()` runs. Any
  template is fine as long as it does not prevent the host page from adding its own
  scripts (the built-in **Default** and **Minimal** templates both allow this). If you
  integrate into your own page, follow the same order: connector first, then the
  loader.
- **Decompression Fallback** stays off (only needed for compressed builds on servers
  that can't set `Content-Encoding`).

If Unity rejects the minimal `ProjectSettings.asset` on an editor line other than
2022.3, delete it, let Unity regenerate defaults, and set **Compression Format:
Disabled** + **Run In Background** by hand.

## Run the spec

From the repo root, after `pnpm build` and a one-time
`pnpm --filter @uptimizr/example-playground test:e2e:install`:

```bash
pnpm --filter @uptimizr/example-playground exec playwright test unity-export
```

The spec:

1. serves `dist/` at `/unity-build/` from the playground's Vite dev server;
2. opens `/unity-export-e2e.html`, which starts `trackUnity(...)` **before**
   `createUnityInstance` (so the bridge global is there for `Start()`);
3. waits for the export to load, clicks the centre of the canvas (→ `CenterCube`), and
4. asserts `session_start.connector.name === "unity"`, `camera_sample` (from
   `pushPose`), `mesh_interaction` (from `pushPick`, `mesh === "CenterCube"`), and
   `frame_perf` all reach the collector.

Without a build it reports one skipped test:
`No Unity WebGL build at examples/unity-web-export/dist`.

## Automation status

Automating the Unity build in CI (e.g. via game-ci) is **deferred**: it needs a Unity
license activation step and a large editor image. The cheap automated check is the
`.jslib` sanity test in `oss/packages/unity/src/__tests__/jslib.test.ts`, which
evaluates the shim under `node:vm` with mocked Emscripten globals and asserts every
export forwards to the bridge — that runs in every `pnpm test`.
