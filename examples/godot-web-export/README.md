# Godot web-export sample (`examples/godot-web-export`)

The **reference integration** for the [`@uptimizr/godot`](../../oss/packages/godot/README.md)
connector's _bridged tier_ (ADR 0045), and the project behind the automated proof that the
shipped engine-side shim actually runs: CI exports it headlessly to WebAssembly and drives it
with Playwright (`examples/playground/e2e/godot-export.spec.ts`, issue #252).

It is deliberately tiny — a Godot 4 project with:

| File                        | Purpose                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `project.godot`             | Registers the `UptimizrGodot` **autoload**; GL Compatibility renderer (the one the Web export supports).          |
| `uptimizr/UptimizrGodot.gd` | Byte-identical **copy** of the package shim `oss/packages/godot/bridge/UptimizrGodot.gd` (see "Do not fork").     |
| `main.tscn`                 | A `Camera3D` at `(0, 1.5, 6)` looking down −Z, a `Crate` and an `Orb` (`StaticBody3D` + mesh + collision), floor. |
| `main.gd`                   | Opts the two props into the scene proxy (`uptimizr_tracked` group) and calls `UptimizrGodot.push_scene_proxy()`.  |
| `export_presets.cfg`        | A `Web` preset with `variant/thread_support=false` → the **nothreads** template, no COOP/COEP headers needed.     |

Everything the connector needs from the game is what a real game would do: register the
autoload, name the nodes you want reported, and (optionally) mark the ones for the scene proxy.
The autoload does the rest — camera pose each frame, FPS, and a physics raycast on left-click
that reports the collider's node name (`Crate` / `Orb`) with the world hit point.

## Build it (headless, no editor UI)

```bash
pnpm godot:fetch      # once — downloads the pinned Godot 4 editor + the web_nothreads_release template
pnpm godot:export     # godot --headless --import && --export-release Web → dist/index.html (gitignored)
pnpm test:e2e:godot   # boots the export in the playground and asserts the bridged tier round trip
```

- `godot:fetch` (`scripts/godot-fetch.mjs`) installs the editor into `~/.local/share/godot/bin/`
  and the template into `~/.local/share/godot/export_templates/<version>/`, honouring
  `XDG_DATA_HOME` like Godot does. The 1.2 GB export-templates bundle is a plain zip and GitHub
  release assets honour HTTP `Range`, so the script reads the bundle's central directory and
  range-fetches **only** the ~10 MB `web_nothreads_release.zip` member. Total transfer ≈ 85 MB
  (mostly the editor). Idempotent; override with `GODOT_BIN`, `GODOT_DATA_DIR`,
  `GODOT_WEB_TEMPLATES`, `GODOT_DOWNLOAD_BASE`.
- `godot:export` (`scripts/godot-export.mjs`) fails if the shim copy drifted, if Godot reports a
  script error (Godot otherwise exits 0 even when an autoload fails to compile), or if the
  expected `index.{html,js,wasm,pck}` are missing.
- The pinned version lives in `scripts/godot-common.mjs` (`GODOT_VERSION`); the CI cache key in
  `.github/workflows/{pr,main}.yml` repeats it.

## How the e2e drives it

`examples/playground/godot-export-e2e.html` (+ `src/godot-export-e2e.ts`) calls `trackGodot(...)`
**before** booting the engine, so `window.__uptimizr_godot__` exists when the autoload's `_ready`
runs, then loads the export's `index.js` and starts it into the page's canvas (the Vite dev
server serves `dist/` under `/godot-export/`). The spec waits for the first `camera_sample`,
clicks the canvas centre, and asserts `camera_sample` (Z negated: Godot `z=+6` → canonical
`z=-6`), `mesh_interaction` (`mesh: "Crate"`, hit `z=+0.5` → `-0.5`), `frame_perf`,
`pointer_click`, `session_start.connector.name === "godot"`, and the normalized scene proxy.

Without an export present the spec **skips** itself, so the default `pnpm test:e2e` stays green
on machines without Godot; CI's `godot-export-e2e` job sets `GODOT_E2E_REQUIRED=1`.

## Do not fork the shim

Godot only loads scripts from inside the project, so the shim is copied in — but it must stay
identical to the package source so the test proves the shipped asset:

```bash
pnpm godot:check-bridge         # fails on drift (CI runs this before exporting)
pnpm godot:check-bridge --fix   # re-copy after editing oss/packages/godot/bridge/UptimizrGodot.gd
```

## Open it in the editor

The project opens in Godot 4.7 like any other (`godot --path examples/godot-web-export -e`).
Off the Web export the autoload is a no-op (`OS.has_feature("web")` guard), so running the scene
in the editor just shows the props. The `.godot/` import cache and `dist/` are gitignored; the
`*.uid` sidecars Godot 4.4+ generates for scripts are committed.
