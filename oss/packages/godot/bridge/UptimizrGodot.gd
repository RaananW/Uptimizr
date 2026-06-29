# UptimizrGodot.gd — engine-side bridge for the @uptimizr/godot connector (ADR 0045).
#
# Copy-in asset (Apache-2.0). NOT an npm package. Add it as an Autoload singleton in a
# Godot 4 project to enable the connector's *bridged tier* (camera pose / world-space
# picks / FPS / scene proxy). The *JS-only tier* (pointer heatmaps + FPS + JS errors)
# already works with no engine code.
#
# Setup:
#   1. Load @uptimizr/godot in the Web export's host page and call `trackGodot(...)`,
#      which exposes the bridge on `window.__uptimizr_godot__`.
#   2. Project > Project Settings > Globals > Autoload: add this script as `UptimizrGodot`.
#
# This shim carries NO analytics logic, IDs, or schema knowledge. It reads the engine's
# own camera / raycast / perf and hands **world-space values in Godot's NATIVE frame**
# (right-handed, y-up, meters) to the connector, which owns all normalization (negates Z)
# and schema mapping.
#
# Privacy (ADR 0003): only low-cardinality, non-PII telemetry crosses the bridge — poses,
# FPS, and developer-named objects. It MUST NOT invent identifiers or forward raw input.
extends Node

## Expected bridge wire-protocol version (must match BRIDGE_PROTOCOL_VERSION in
## @uptimizr/web-export). The shim refuses to push if the page's bridge disagrees.
const PROTOCOL_VERSION := 1

## The `window` property the connector exposes the bridge on (the connector's
## `bridgeGlobal`; defaults to `__uptimizr_<name>__`).
const BRIDGE_GLOBAL := "__uptimizr_godot__"

## Push at most this many camera poses per second (the connector also throttles its
## screen-space tier). Keeps per-frame JS-array allocation bounded. Set <= 0 to push
## every frame.
@export var pose_samples_per_second: float = 30.0

## When true, a left mouse click casts a ray from the camera through the pointer and
## pushes the first named collider it hits as a pick.
@export var capture_picks: bool = true

## Physics ray length (metres) used for click picks.
@export var pick_ray_length: float = 1000.0

## Nodes in this group are included when `push_scene_proxy()` is called. Opt-in by
## design so only developer-marked, named objects are described (privacy + low
## cardinality). Add `VisualInstance3D` nodes to it via `add_to_group("uptimizr_tracked")`.
const SCENE_PROXY_GROUP := "uptimizr_tracked"

var _bridge: JavaScriptObject = null
var _ready_ok := false
var _accum := 0.0


func _ready() -> void:
	# The bridge only exists in a Web export; no-op everywhere else.
	if not OS.has_feature("web"):
		set_process(false)
		set_process_unhandled_input(false)
		return

	_bridge = JavaScriptBridge.get_interface(BRIDGE_GLOBAL)
	if _bridge == null:
		push_warning("[Uptimizr] bridge global '%s' not found — call trackGodot() in the host page before this autoload runs." % BRIDGE_GLOBAL)
		set_process(false)
		set_process_unhandled_input(false)
		return

	# Refuse to push against an incompatible bridge contract.
	var version := int(_bridge.protocolVersion)
	if version != PROTOCOL_VERSION:
		push_warning("[Uptimizr] bridge protocol mismatch (page=%d, shim=%d) — disabling pose/pick capture." % [version, PROTOCOL_VERSION])
		_bridge = null
		set_process(false)
		set_process_unhandled_input(false)
		return

	_ready_ok = true


func _process(delta: float) -> void:
	if not _ready_ok:
		return

	if pose_samples_per_second > 0.0:
		_accum += delta
		var interval := 1.0 / pose_samples_per_second
		if _accum < interval:
			# Still report FPS every frame even when skipping a pose sample.
			_push_perf()
			return
		_accum = 0.0

	_push_pose()
	_push_perf()


func _push_pose() -> void:
	var cam := get_viewport().get_camera_3d()
	if cam == null:
		return
	var xform := cam.global_transform
	var p := xform.origin
	# Godot cameras look down their local -Z; pass the WORLD-space forward vector.
	var f := -xform.basis.z
	var u := xform.basis.y
	# Camera3D.fov is vertical degrees by default (KEEP_HEIGHT); the bridge wants radians.
	_bridge.pushPose(_vec3(p), _vec3(f), _vec3(u), deg_to_rad(cam.fov))


func _push_perf() -> void:
	_bridge.pushPerf(Engine.get_frames_per_second())


func _unhandled_input(event: InputEvent) -> void:
	if not _ready_ok or not capture_picks:
		return
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		_push_pick_at(event.position)


func _push_pick_at(screen_pos: Vector2) -> void:
	var cam := get_viewport().get_camera_3d()
	if cam == null:
		return
	var from := cam.project_ray_origin(screen_pos)
	var to := from + cam.project_ray_normal(screen_pos) * pick_ray_length
	var space := cam.get_world_3d().direct_space_state
	var query := PhysicsRayQueryParameters3D.create(from, to)
	var hit := space.intersect_ray(query)
	if hit.is_empty():
		return
	var collider: Object = hit.get("collider")
	if collider == null or not (collider is Node):
		return
	# Only the developer-assigned node name and the world hit point are sent (ADR 0003).
	var point: Vector3 = hit.get("position")
	_bridge.pushPick(String((collider as Node).name), _vec3(point))


## Push a spatial proxy of the named, developer-marked nodes in `SCENE_PROXY_GROUP`.
## Call this once after your scene is built (it is NOT automatic — opt-in keeps the proxy
## low-cardinality and free of incidental geometry). Sends world-space AABBs in Godot's
## native frame; the connector normalizes them.
func push_scene_proxy() -> void:
	if not _ready_ok:
		return
	var nodes := JavaScriptBridge.create_object("Array")
	for node in get_tree().get_nodes_in_group(SCENE_PROXY_GROUP):
		if not (node is VisualInstance3D):
			continue
		var vi := node as VisualInstance3D
		var local := vi.get_aabb()
		var world := vi.global_transform * local
		var min_p := world.position
		var max_p := world.position + world.size
		var entry := JavaScriptBridge.create_object("Object")
		entry.name = String(vi.name)
		entry.aabb = JavaScriptBridge.create_object(
			"Array", min_p.x, min_p.y, min_p.z, max_p.x, max_p.y, max_p.z
		)
		nodes.push(entry)
	_bridge.setSceneProxy(nodes)


## Detach the bridge; subsequent pushes become no-ops on the JS side too.
func dispose() -> void:
	if _bridge != null:
		_bridge.dispose()
	_bridge = null
	_ready_ok = false
	set_process(false)
	set_process_unhandled_input(false)


# Build a JS `[x, y, z]` array the connector can read. Raw GDScript Arrays do not
# auto-marshal across the JS boundary, so we construct a real JS Array via the bridge.
func _vec3(v: Vector3) -> JavaScriptObject:
	return JavaScriptBridge.create_object("Array", v.x, v.y, v.z)
