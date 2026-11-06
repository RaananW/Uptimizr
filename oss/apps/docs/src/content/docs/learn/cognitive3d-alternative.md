---
title: Uptimizr vs Cognitive3D
description: An open-source alternative to Cognitive3D for web 3D scenes. Compare engines, hosting, licensing and replay, and see when Cognitive3D is the better fit.
lastUpdated: 2026-11-06
---

Uptimizr and Cognitive3D both measure how people behave in 3D, but they aim at different work.
[Cognitive3D](https://cognitive3d.com/) is a hosted spatial analytics platform with a strong VR and
XR focus. Uptimizr is an open-source, self-hosted collector for 3D scenes on the web. If you're
building for headsets, especially with biometric or eye-tracking data, look at Cognitive3D first. If
you're building for the browser and want to own your data, Uptimizr is likely the better fit.

:::note[Checked November 2026]
This comparison uses Cognitive3D's public [pricing](https://cognitive3d.com/pricing/) and
[WebXR framework support](https://docs.cognitive3d.com/webxr/framework-support/) pages. Check them for
current details, because plans and features change. We build Uptimizr, so read this with that in mind.
:::

## At a glance

|                   | Uptimizr                                            | Cognitive3D                                                                                            |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Main focus        | 3D scenes on the web                                | Spatial analytics, with a focus on VR and XR                                                           |
| Hosting           | Self-hosted only                                    | Hosted; dedicated cloud or on-premises on the Enterprise plan                                          |
| Source            | Open source (Apache-2.0)                            | Public WebXR SDK repository, with [its own license file](https://github.com/CognitiveVR/c3d-sdk-webxr) |
| Price             | Free; you pay for your own hosting                  | Free tier, then paid plans priced by monthly tracked users                                             |
| 3D session replay | Included, in your own scene                         | Paid plans; the free tier shows a timeline of events                                                   |
| Data storage      | Your own DuckDB, Postgres, SQL Server or ClickHouse | Cognitive3D's platform, with export options                                                            |
| MCP server        | Included                                            | Listed on the Pro plan                                                                                 |

## Web engine coverage

Cognitive3D's WebXR SDK is most complete on three.js and Mattercraft. Its published table lists core
API and automatic gaze tracking for Babylon, plus performance sensors for PlayCanvas.

| Capability                 | Uptimizr: three.js, Babylon.js, PlayCanvas | Cognitive3D: three.js | Cognitive3D: Babylon | Cognitive3D: PlayCanvas |
| -------------------------- | ------------------------------------------ | --------------------- | -------------------- | ----------------------- |
| Camera or gaze tracking    | Yes                                        | Yes                   | Yes                  | Yes                     |
| Automatic performance data | Yes                                        | Yes                   | No                   | Yes                     |
| Moving object capture      | Yes, as scene actors                       | Yes                   | No                   | No                      |

Uptimizr also has connectors for [Babylon Lite](/docs/connectors/babylon-lite/),
[react-three-fiber](/docs/connectors/r3f/) and [A-Frame](/docs/connectors/aframe/), plus
[Unity, Godot and Unreal web exports](/docs/learn/unity-godot-unreal-web-analytics/). Cognitive3D
supports Mattercraft and Wonderland Engine, which Uptimizr doesn't have dedicated connectors for.

## When Cognitive3D is the better choice

- You ship **native VR or AR apps** for headsets. Uptimizr only covers the web.
- You need **eye tracking or biometric sensors**. Cognitive3D lists these on its academic plan, while
  Uptimizr's gaze data comes from camera direction and XR input.
- You want a **hosted service** with enterprise support and don't want to run anything yourself.

## When Uptimizr is the better choice

- You're building **browser-based 3D**, such as product viewers, configurators, games or digital
  twins, rather than headset-first apps.
- You want **your data on your own infrastructure**, using a single
  [self-hosted collector](/docs/deploy/collector/) with an embedded database.
- You need **cookieless, privacy-first capture** by default. See the
  [privacy model](/docs/deploy/privacy/).
- You work in **Babylon.js or PlayCanvas** and want the same capture as three.js.
- You want **open-source code** you can read, change and extend under Apache-2.0.

## Try it

You can compare for yourself in a few minutes: open the [live demo](https://demo.uptimizr.com), or
follow the [Quickstart](/docs/quickstart/) to add Uptimizr to your own scene.
