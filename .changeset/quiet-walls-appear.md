---
"@uptimizr/react": patch
---

Session preview and whole-building backdrop no longer collapse unnamed proxy meshes into one box. Meshes registered with an empty name (e.g. an unnamed three.js `Mesh`) were de-duplicated by name, so only the first unnamed wall/pedestal of a scene was drawn; unnamed meshes now key on their path + AABB instead.
