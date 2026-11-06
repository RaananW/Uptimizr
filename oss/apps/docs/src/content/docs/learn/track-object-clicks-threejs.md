---
title: Track which objects users click in three.js
description: Log and rank clicks on 3D objects in a three.js scene, with a hand-built Raycaster or the @uptimizr/three connector, including hover and dead clicks.
lastUpdated: 2026-11-06
---

To track clicks on objects in three.js, you need to do two things: turn each click into a raycast
that finds the object under the pointer, and store the object's name somewhere you can count it. You
can build this yourself in about ten lines, then decide whether you also want to build everything
around it.

## Build it with a Raycaster

Convert the click to normalized device coordinates, cast a ray from the camera, and report the
nearest hit:

```ts
import * as THREE from "three";

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener("click", (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const [hit] = raycaster.intersectObjects(scene.children, true);
  if (!hit) return;

  sendToYourAnalytics({ object: hit.object.name, point: hit.point.toArray() });
});
```

This is enough to log a click. A usable report also needs:

- **Delivery:** batching events, and flushing them when the visitor closes the tab.
- **Storage and ranking:** somewhere to keep the events and a way to rank objects across sessions.
- **Misses:** clicks that hit nothing are often the most useful ones, and the snippet above drops
  them.
- **Pointer lock:** in first-person scenes the cursor is hidden, so the aim point is the centre of
  the screen and not `event.clientX`.

## Use a connector

[`@uptimizr/three`](/docs/connectors/three/) does the raycasting and delivery for you and adds
camera, pointer and performance capture:

```bash
npm install @uptimizr/three three
```

```ts
import { trackScene } from "@uptimizr/three";

const client = trackScene(scene, camera, renderer, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
```

Every click or tap that hits geometry now emits a `mesh_interaction` event with the mesh name and the
world-space hit point. No further setup is needed. The endpoint is a
[collector you run yourself](/docs/deploy/collector/).

:::note[Using another engine?]
The same capture is available for [Babylon.js](/docs/connectors/babylon/),
[react-three-fiber](/docs/connectors/r3f/) and [PlayCanvas](/docs/connectors/playcanvas/). In
react-three-fiber you add `<Uptimizr />` inside your `<Canvas>`.
:::

## Name your meshes

Results are only as good as your object names. The hit is reported using the name of the mesh the ray
struck, not its parent group, so name the meshes themselves:

```ts
gltf.scene.getObjectByName("Cube012").name = "product-hero";
```

Procedural or clone-suffixed names such as `Box.001` and `Box.002` split one object across several
rows in your ranking, and an unnamed mesh reports an empty name. Give every interactive mesh a
deliberate, stable name.

## See the most-clicked objects

The dashboard shows the ranking as the most-interacted meshes view, and the
[query API](/docs/api/query/) returns the same data:

```http
GET /api/v1/meshes/top?since=...&limit=20
x-api-key: your-project-api-key
```

## Go beyond clicks

Clicks only show what people successfully acted on. These signals show what they tried and missed:

| You want to know                         | Use                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| What people click that does nothing      | `GET /api/v1/clicks/dead` reports clicks that hit no geometry                                        |
| Where people get frustrated              | `GET /api/v1/clicks/rage` reports rapid repeated clicks on one mesh                                  |
| What looks interactive but gets no click | [`hoverDwell`](/docs/guides/mesh-tracking/#hover-hesitation-hover_dwell--opt-in)                     |
| What's on screen but ignored             | [Blind spots](/docs/guides/mesh-tracking/#blind-spots--never-noticed-meshes), using `meshVisibility` |

Hover and visibility capture are off by default. Turn them on when you need them:

```ts
const client = trackScene(scene, camera, renderer, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  capture: { hoverDwell: true },
  meshVisibility: { meshes: ["product-hero"] },
});
```

## Next steps

- Follow the [Quickstart](/docs/quickstart/) to run a collector and see your first heatmap.
- Read [Track 3D object interactions](/docs/guides/mesh-tracking/) for every capture option.
- Try the [live demo](https://demo.uptimizr.com) to explore the reports without installing anything.
