---
title: Why Google Analytics can't see inside a 3D scene
description: Google Analytics measures pages and the events you send it. Learn what GA4 misses inside a WebGL canvas, and how to use it alongside 3D analytics.
lastUpdated: 2026-11-06
---

Google Analytics measures pages and the events you send it, and everything in a 3D scene happens
inside one `<canvas>` element. GA4 can tell you that someone opened your 3D page and how long they
stayed. It can't tell you what they looked at, which object they tried to click, or whether the scene
ran at 12 frames per second on their phone.

This isn't a flaw in GA4. It was built for pages, and it remains a good tool for measuring them.

## Why the canvas is a blind spot

A page-based tool learns about a page from its links, buttons and URLs. A WebGL or WebGPU scene has
none of those inside the canvas: the browser only sees a rectangle of pixels. Meshes, cameras and
materials exist in your engine, not in the page. So anything GA4 reports about the inside of your
scene has to be sent there by your own code.

## Can you send 3D events to GA4 anyway?

Yes. GA4 accepts [custom events](https://developers.google.com/analytics/devguides/collection/ga4/events),
so you can report meaningful moments:

```ts
gtag("event", "object_click", { object_name: "product-hero" });
```

This works well for discrete actions such as "selected the walnut finish" or "finished level 3". It
stops working well when the data is spatial or continuous:

- **Camera direction** needs regular samples, and turning those samples into a heatmap needs spatial
  binning that GA4 reports don't provide.
- **Hit positions** are coordinates. You can send them as parameters, but you can't plot them over
  your scene in GA4.
- **Frame rate** needs percentiles across sessions and devices rather than a count of events.
- **Limits apply.** GA4 [allows 25 parameters per event](https://support.google.com/analytics/answer/9267744)
  on the standard tier, which leaves little room for structured scene data.

## What each tool answers

| Question                                 | GA4                   | 3D analytics          |
| ---------------------------------------- | --------------------- | --------------------- |
| How did visitors find this page?         | Yes                   | No                    |
| Which pages do they view?                | Yes                   | No                    |
| Did they complete a purchase?            | If you send the event | If you send the event |
| Which object did they click?             | If you send the event | Yes                   |
| Where did they look?                     | No                    | Yes                   |
| What did they never notice?              | No                    | Yes                   |
| Where in the scene does FPS drop?        | No                    | Yes                   |
| Can I replay what happened in the scene? | No                    | Yes                   |

## Use both

You don't have to replace GA4. Keep it for acquisition, page traffic and conversions, and add a 3D
tool for what happens in the canvas. The two don't conflict: Uptimizr runs alongside GA4 and reports
to your own [self-hosted collector](/docs/deploy/collector/).

If you also want the two to tell one story, report key scene moments to both:

```ts
function onAddToCart(sku: string) {
  gtag("event", "add_to_cart", { item_id: sku });
  client.track("add_to_cart", { sku });
}
```

## Privacy differences

GA4 uses first-party cookies by default, so many sites need consent before it can run. Uptimizr's
default setup writes no cookies and no persistent identifiers: the `sessionId` is held in memory and
visitors are counted with a server-side hash that rotates daily. See
[Privacy & configuration](/docs/deploy/privacy/) for details. Whether you need a consent banner still
depends on your jurisdiction and what you capture.

## Next steps

- Read [What is 3D analytics?](/docs/learn/) for an overview of the signals.
- Follow the [Quickstart](/docs/quickstart/) to add a connector to your scene.
- Try the [live demo](https://demo.uptimizr.com) to see the reports.
