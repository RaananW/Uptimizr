---
title: Analytics for 3D product configurators
description: Measure how shoppers use a 3D product configurator, including which options get attention, how much of the product they see, and where they drop off.
lastUpdated: 2026-11-06
---

A 3D product configurator is only worth its cost if shoppers use it and it helps them decide. Page
analytics shows whether they opened the page and bought. 3D analytics fills in what happens between
those two moments: which options they tried, how much of the product they saw, what they missed, and
where they gave up.

:::note[This guide assumes you build the viewer]
Uptimizr reads your 3D scene directly, so you need access to the viewer's code. It works when the
configurator is built on an engine such as [three.js](/docs/connectors/three/) or
[Babylon.js](/docs/connectors/babylon/), but not with a closed viewer embedded from a third party.
:::

## Questions worth answering

| Question                               | What to look at                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| How much of the product do people see? | `GET /api/v1/coverage/view-histogram`, for example how many visitors saw less than a quarter of the view dome |
| Do they interact, or just look?        | `GET /api/v1/camera-gestures` for orbit, pan and zoom, and `GET /api/v1/meshes/top` for object clicks         |
| Which part of a surface draws clicks?  | `GET /api/v1/heatmaps/mesh-uv` for hot spots on a single mesh                                                 |
| Which features does nobody notice?     | [`GET /api/v1/meshes/blind-spots`](/docs/guides/mesh-tracking/#blind-spots--never-noticed-meshes)             |
| What looks clickable but isn't?        | `GET /api/v1/clicks/dead` and [hover dwell](/docs/guides/mesh-tracking/#hover-hesitation-hover_dwell--opt-in) |
| Do slow loads lose shoppers?           | `GET /api/v1/load-bounce` for bounce rate by load time                                                        |
| Where do shoppers drop off?            | `GET /api/v1/funnel`, described below                                                                         |

## Set it up

Add the connector for your engine, then make three additions that are specific to configurators. This
example uses three.js.

```ts
import { trackScene } from "@uptimizr/three";

const client = trackScene(scene, camera, renderer, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
  capture: { hoverDwell: true },
  meshVisibility: {}, // needed for blind-spot reports
});
```

### 1. Give each model its own scene

If shoppers swap between models in one viewer, call `setScene` when the model changes. Each model then
gets its own heatmaps, even though it's all one session.

```ts
function showModel(sku: string) {
  viewer.load(sku);
  client.setScene(sku); // for example "chair-walnut"
}
```

Use stable product identifiers here, not generated IDs.

### 2. Record the choices shoppers make

Connectors capture clicks and camera movement automatically, but they can't know what an action means
to your business. Report those moments with custom events:

```ts
client.track("option_selected", { option: "finish", value: "walnut" });
client.track("add_to_cart", { sku: "chair-walnut", price: 349 });
```

Keep custom events free of personal data.

### 3. Name your meshes

Reports are grouped by mesh name, so give selectable parts clear, stable names such as `chair-seat`
and `chair-leg`. See [Name your meshes](/docs/learn/track-object-clicks-threejs/#name-your-meshes).

## Build a funnel

A funnel shows how many sessions reached each step, in order. You pass the steps with the request as
JSON, and each step matches an event type and, optionally, a name or mesh:

```json
[
  { "type": "camera_gesture", "name": "orbit", "label": "Rotated the product" },
  { "type": "custom", "name": "option_selected", "label": "Chose an option" },
  { "type": "custom", "name": "add_to_cart", "label": "Added to cart" }
]
```

URL-encode that array and send it as the `steps` parameter of
[`GET /api/v1/funnel`](/docs/api/query/#funnels--conversion). Add the `scene` parameter to focus on one
product. A big drop between the first two steps usually means people like looking at the product but
don't find the options.

## Privacy

Shoppers aren't tracked across days. The default setup writes no cookies or persistent identifiers,
and visitors are counted with a server-side hash that rotates daily. See
[Privacy & configuration](/docs/deploy/privacy/).

## Next steps

- Follow the [Quickstart](/docs/quickstart/) to add a connector and run a collector.
- See how to handle model swaps in [Multi-scene experiences](/docs/guides/multi-scene/).
- Explore example reports in the [live demo](https://demo.uptimizr.com).
