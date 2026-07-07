---
"@uptimizr/playcanvas": patch
---

Align the internal `WorldTransformEntity` shape with PlayCanvas 2.20.6, which
made `GraphNode.children` `readonly`. The subtree walker only reads `children`,
so the structural type is now `readonly` too — fixing a `tsc` build break after
the PlayCanvas bump with no behavior change.
