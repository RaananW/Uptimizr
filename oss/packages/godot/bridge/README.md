# Godot engine-side bridge (copy-in asset)

The thin Godot 4 shim that unlocks the **bridged tier** (camera pose / view-direction
heatmap, world-space picks, FPS, scene proxy, replay) of the
[`@uptimizr/godot`](../README.md) connector. The **JS-only tier** (pointer heatmaps, FPS,
and JS errors) already works with **no** engine code — this shim is only needed for the
3D-native channels.

It ships as a **copy-in asset**, not an npm/NuGet package:

- [`UptimizrGodot.gd`](./UptimizrGodot.gd) — GDScript autoload (recommended).
- [`UptimizrGodot.cs`](./UptimizrGodot.cs) — C# autoload for Godot 4 .NET projects.

Both are Apache-2.0 and functionally identical — use the one matching your project's
language.

## What the shim is

A small, dumb shim that pushes per-sample telemetry from Godot across the JS interop
boundary to the browser-side connector. It carries **no** analytics logic, IDs, or schema
knowledge (ADR 0045). For Godot 4 Web exports it is an **autoload** that uses
`JavaScriptBridge` (`JavaScriptBridge.get_interface(...)` / `create_object`) to call the
connector each sample with the active `Camera3D` pose, raycast picks, and FPS.

## Setup

1. **Host page** — load `@uptimizr/godot` in the page that hosts the Web export and start
   a session. `trackGodot(...)` exposes the bridge on `window.__uptimizr_godot__`:

   ```ts
   import { trackGodot } from "@uptimizr/godot";

   trackGodot({
     projectId: "your-project",
     endpoint: "https://collect.example.com",
     canvas: () => document.querySelector("#godot-canvas"),
   });
   ```

2. **Godot project** — copy `UptimizrGodot.gd` (or `.cs`) into your project, then register
   it as a singleton: **Project → Project Settings → Globals → Autoload**, add the script
   with node name `UptimizrGodot`, and enable it. On the next Web export it finds the
   bridge and starts pushing poses, picks, and FPS automatically.

Off the Web export (editor, desktop, mobile) the autoload guards on `OS.has_feature("web")`
and is a no-op, so it is safe to leave enabled in every build.

### Options (exported on the autoload)

| Property                  | Default | Meaning                                                                 |
| ------------------------- | ------- | ----------------------------------------------------------------------- |
| `pose_samples_per_second` | `30`    | Pose push rate cap (`<= 0` pushes every frame). FPS is sent each frame. |
| `capture_picks`           | `true`  | Left-click casts a physics ray and pushes the first named collider.     |
| `pick_ray_length`         | `1000`  | Ray length (metres) for click picks.                                    |

### Scene proxy (optional)

For world-space object engagement and replay completeness, mark the nodes you want
described (developer opt-in — keeps the proxy low-cardinality and PII-free), then push once
after your scene is built:

```gdscript
$Crate.add_to_group("uptimizr_tracked")   # any VisualInstance3D
UptimizrGodot.push_scene_proxy()
```

## The JS API the shim calls

The connector exposes an `EngineBridge` on `window.__uptimizr_godot__` (configurable via
the connector's `bridgeGlobal` option). **All values are world-space in Godot's native
frame** (right-handed, y-up, meters); the connector negates Z to reach the canonical wire
frame and emits the schema events — the shim does **no** coordinate math.

```ts
interface EngineBridge {
  readonly protocolVersion: number; // assert against BRIDGE_PROTOCOL_VERSION (1)
  pushPose(position: [x, y, z], forward: [x, y, z], up: [x, y, z], fov?: number): void;
  pushPick(objectName: string, hitPoint: [x, y, z]): void;
  pushPerf(fps: number, longFrames?: number): void;
  setSceneProxy(nodes: { name: string; aabb: [minX, minY, minZ, maxX, maxY, maxZ] }[]): void;
  dispose(): void;
}
```

The shim asserts `protocolVersion === 1` on startup and disables itself on a mismatch, so a
newer page bridge never receives malformed pushes.

### Coordinate notes

- Pass the camera's **world-space forward vector** — `-cam.global_transform.basis.z`
  (Godot cameras look down local −Z), not a local rotation.
- `Camera3D.fov` is **vertical degrees** by default (`KEEP_HEIGHT`); the bridge wants
  **radians**, so the shim sends `deg_to_rad(cam.fov)`.
- Raw GDScript/C# arrays do **not** auto-marshal across the JS boundary, so the shim builds
  real JS arrays via `JavaScriptBridge.create_object("Array", x, y, z)`.

## Privacy (ADR 0003)

The shim transmits only low-cardinality, non-PII telemetry: poses, FPS, and
developer-assigned **named** objects. It MUST NOT invent identifiers or forward raw input
text. Picks send only the node `name` you authored and the world hit point; the scene proxy
sends only the nodes you explicitly mark.
