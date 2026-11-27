---
title: Uptimizr vs PostHog and Mixpanel for 3D apps
description: What PostHog and Mixpanel can and can't see inside a WebGL or three.js canvas, how their heatmaps and canvas replay compare with 3D analytics, and how to use them together.
lastUpdated: 2026-11-27
---

PostHog and Mixpanel are product analytics tools for pages, apps and the events you send them.
Uptimizr is analytics for what happens inside a 3D scene. They answer different questions, and
most 3D teams that already use PostHog or Mixpanel should keep it and add a 3D tool beside it, not
replace it.

The short version: PostHog and Mixpanel see a WebGL scene as one `<canvas>` element. They can count
events you send from it, and record it as low-frame-rate images, but they can't tell you which mesh
was clicked, where the camera pointed or which part of the scene drops frames, unless you build that
yourself.

:::note[Checked November 2026]
This comparison uses PostHog's and Mixpanel's public documentation and pricing pages, linked below.
Check them for current details, because plans and features change. We build Uptimizr, so read this
with that in mind.
:::

## At a glance

|                        | Uptimizr                                           | PostHog                                        | Mixpanel                                   |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| Built for              | Behaviour inside 3D scenes                         | Product analytics for web and mobile apps      | Product analytics for web and mobile apps  |
| Hosting                | Self-hosted only                                   | Cloud, or a self-hosted hobby deployment       | Cloud, with US or EU data residency        |
| Source                 | Open source (Apache-2.0)                           | Open source (MIT), except the `ee` directory   | Closed source                              |
| Clicks inside a canvas | Mesh name and 3D hit point, automatically          | Page coordinates, or events you send           | Page coordinates, or events you send       |
| Heatmaps               | Screen, 3D world, view direction, gaze, floor plan | Page click, scroll and mouse-movement heatmaps | Page click, coordinate and scroll heatmaps |
| Replay of a 3D scene   | Re-driven from events in your own scene            | Canvas captured as images, off by default      | Canvas captured as images, off by default  |
| Real-user FPS          | Captured, with percentiles and per-device views    | Not built in                                   | Not built in                               |
| Funnels and retention  | Per-session funnel over steps you define           | Full product analytics suite                   | Full product analytics suite               |
| Price                  | Free; you pay for your own hosting                 | Free tier, then usage-based                    | Free tier, then usage-based                |

## What PostHog sees in a 3D scene

- **Heatmaps** are page-based. PostHog's [heatmaps](https://posthog.com/docs/toolbar/heatmaps) show
  where on the page people click and move their mouse, clickmaps over DOM elements, and scroll
  depth. A click on a canvas is a point on the page, with no record of what was drawn there.
- **Autocapture** records clicks on elements such as links, buttons and form fields, as listed in
  the [autocapture docs](https://posthog.com/docs/product-analytics/autocapture). A canvas isn't on
  that list, and nothing inside the canvas is an element.
- **Canvas recording** in session replay
  [works for WebGL](https://posthog.com/docs/session-replay/canvas-recording). It's off by default,
  records 4 frames per second by default and up to 12, and isn't covered by DOM-based masking, so
  you mask canvas regions yourself.
- **Self-hosting** is a free Docker Compose deployment under the MIT license. The
  [repository](https://github.com/PostHog/posthog) describes it as scaling to about 100,000 events a
  month, without customer support, and PostHog recommends its cloud for most users.

## What Mixpanel sees in a 3D scene

- **Heatmaps** [come from session replay data](https://docs.mixpanel.com/docs/session-replay/heatmaps):
  click maps over page elements, coordinate heatmaps and scroll maps. They only cover sessions that
  were recorded.
- **Canvas recording** is an option in the
  [JavaScript replay SDK](https://docs.mixpanel.com/docs/tracking-methods/sdks/javascript/javascript-replay).
  `record_canvas` is off by default and, when on, snapshots `<canvas>` elements at up to 15 frames
  per second. Mixpanel notes that the underlying canvas replay is experimental.
- **Sending 3D data as events** runs into property limits. Each event
  [can have up to 255 properties](https://docs.mixpanel.com/docs/data-structure/events-and-properties),
  and [list and object properties are capped at 8 KB](https://docs.mixpanel.com/docs/data-structure/property-reference/data-type),
  which is fine for "selected the walnut finish" and tight for a camera path.

## Can't I just send 3D events to them?

You can, and for discrete moments it works well:

```ts
posthog.capture("object_click", { object: "product-hero" });
mixpanel.track("object_click", { object: "product-hero" });
```

What you'd have to build yourself is everything spatial:

- **Raycasting** each click to find the object under the pointer, and ignoring orbit drags.
- **Camera sampling** at a steady rate, skipping samples while the camera is still.
- **Spatial binning** of hit points, camera directions and positions into heatmaps, then a viewer
  that draws them over your scene.
- **Frame-rate percentiles** per session and per device, rather than a count of events.
- **Replay** that moves your camera through a session, not a 4 to 15 frames-per-second picture of
  it.

That's the part a 3D analytics tool does for you.

## When PostHog or Mixpanel is the better choice

- Your questions are about **pages, sign-ups, acquisition, retention and revenue**, and the 3D view
  is a small part of the product.
- You want **one hosted tool** for analytics, replay, feature flags and experiments across the whole
  app.
- You need **mature funnel, cohort and retention reporting** built for product and growth teams.

## When Uptimizr is the better choice

- The **3D scene is the product**: a configurator, viewer, game, digital twin or WebXR experience.
- You need to know **which objects** people click, look at, hover and ignore, and **where in the
  scene** things go wrong.
- You want **real-user FPS** from your visitors' devices, broken down by GPU and browser.
- You want **your data on your own infrastructure**, with
  [cookieless capture](/docs/deploy/privacy/) by default.
- You use **three.js, React Three Fiber, Babylon.js, PlayCanvas, A-Frame** or a Unity, Godot or
  Unreal web export, and want the capture already written. See the
  [connectors](/docs/connectors/overview/).

## Use them together

Run both: keep PostHog or Mixpanel for the product funnel and add Uptimizr for the scene. Report
the moments that connect the two to both tools, using the same name:

```ts
function onAddToCart(sku: string) {
  posthog.capture("add_to_cart", { sku }); // or mixpanel.track(...)
  client.track("add_to_cart", { sku }); // the Uptimizr client from trackScene
}
```

The two don't conflict. Uptimizr reports to your own [collector](/docs/deploy/collector/), sets no
cookies and doesn't need a shared user id.

## Next steps

- Read [The complete guide to analytics for three.js apps](/docs/learn/threejs-analytics/).
- Read [Session replay for WebGL and 3D scenes](/docs/learn/webgl-session-replay/) for canvas
  recording compared with event replay.
- Try the [live demo](https://demo.uptimizr.com) to see the 3D reports without installing anything.
