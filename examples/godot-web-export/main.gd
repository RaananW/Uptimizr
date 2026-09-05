# Main scene of the Uptimizr Godot web-export sample.
#
# The engine-side bridge (`res://uptimizr/UptimizrGodot.gd`, registered as the
# `UptimizrGodot` autoload) pushes camera pose, FPS, and left-click raycast picks on its
# own. The only integration work a game does is opt its named props into the scene
# proxy — done here once the scene is built.
extends Node3D


func _ready() -> void:
	# Autoloads are ready before the main scene, so the bridge is already attached
	# (or a no-op off the Web export).
	for mesh in [$Crate/CrateMesh, $Orb/OrbMesh]:
		mesh.add_to_group(UptimizrGodot.SCENE_PROXY_GROUP)
	UptimizrGodot.push_scene_proxy()
