# Godot engine-side bridge (copy-in asset)

> **Status: placeholder.** The full Godot shim is authored in the Godot web-export
> connector sub-issue (see umbrella issue #111). This folder documents the contract
> the shim must satisfy so the bridged tier (camera pose / world-space picks /
> replay) drops in. The **JS-only tier** (pointer heatmaps + FPS + errors) already
> works with **no** engine code.

## What the shim is

A small, dumb shim that ships as a **copy-in asset** (not an npm package) and pushes
per-sample telemetry from Godot across the JS interop boundary to the browser-side
`@uptimizr/godot` connector. It carries **no** analytics logic, IDs, or schema
knowledge (ADR 0045).

For Godot 4 Web exports this is a GDScript (or C#) **autoload** that uses
`JavaScriptBridge` (`JavaScriptBridge.get_interface(...)` / `JavaScriptBridge.eval`)
to call the connector each sample with the active `Camera3D`, raycast hits, and FPS.

## The JS API the shim calls

The connector exposes an `EngineBridge` on `window.__uptimizr_godot__` (configurable
via the `bridgeGlobal` option). **All values are world-space in Godot's native
frame** (right-handed, y-up, meters); the connector negates Z to reach the canonical
wire frame and emits the schema events — the shim does **no** coordinate math.

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

### GDScript autoload sketch (illustrative — full version lands in the sub-issue)

```gdscript
extends Node

var _bridge

func _ready():
    if OS.has_feature("web"):
        _bridge = JavaScriptBridge.get_interface("__uptimizr_godot__")

func _process(_delta):
    if _bridge == null:
        return
    var cam := get_viewport().get_camera_3d()
    if cam == null:
        return
    var p := cam.global_position
    var f := -cam.global_transform.basis.z   # Godot cameras look down -Z
    var u := cam.global_transform.basis.y
    _bridge.pushPose([p.x, p.y, p.z], [f.x, f.y, f.z], [u.x, u.y, u.z], deg_to_rad(cam.fov))
    _bridge.pushPerf(Engine.get_frames_per_second())
```

> Note: pass the camera's **world-space forward vector** (e.g. `-basis.z`), not a
> local rotation — the connector normalizes a true world-space direction.

## Privacy (ADR 0003)

The shim transmits only low-cardinality, non-PII telemetry: poses, FPS, and
developer-assigned **named** objects. It MUST NOT invent identifiers or forward raw
input text.
