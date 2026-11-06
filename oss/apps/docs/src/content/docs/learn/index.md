---
title: What is 3D analytics?
description: 3D analytics measures what people look at, click and ignore inside a WebGL, WebGPU or WebXR scene, and how well that scene runs on their devices.
lastUpdated: 2026-11-06
---

**3D analytics measures how people behave inside a 3D scene**: where they look, which objects they
touch, where they go, what they never notice, and how well the scene runs on their device. It does
for product viewers, configurators, browser games, digital twins and WebXR apps what web analytics
does for pages.

Page-based analytics can't do this on its own. A 3D scene renders into a single `<canvas>`, so there
are no links, buttons or sections for a page tool to observe. It can tell you someone opened the page,
but not that they orbited the product twice and never found the engraving on the back.

## What 3D analytics measures

| Question                                  | Signal                                   | Uptimizr guide                                                               |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| What do people look at?                   | Camera direction and view coverage       | [Concepts](/docs/concepts/)                                                  |
| Which objects do they click?              | Raycast hits on named meshes             | [Track 3D object interactions](/docs/guides/mesh-tracking/)                  |
| What looks clickable but isn't?           | Hover dwell, dead clicks and rage clicks | [Track 3D object interactions](/docs/guides/mesh-tracking/)                  |
| What do they never notice?                | On-screen time with no engagement        | [Blind spots](/docs/guides/mesh-tracking/#blind-spots--never-noticed-meshes) |
| Where do they go?                         | Camera position, paths and scene changes | [Multi-scene experiences](/docs/guides/multi-scene/)                         |
| Does it run well on their device?         | FPS, frame time and long frames          | [Real-user performance](/docs/guides/performance/)                           |
| What happened in this particular session? | An ordered stream of scene events        | [Session replay](/docs/guides/replay/)                                       |
| Can I just ask a question?                | An AI agent reading those same metrics   | [Ask an AI agent](/docs/learn/ai-agent-3d-analytics/)                        |

## Guides by goal

- [Ask an AI agent about your 3D analytics](/docs/learn/ai-agent-3d-analytics/): connect Claude or
  another MCP client and ask questions in plain English.
- [Track which objects users click in three.js](/docs/learn/track-object-clicks-threejs/): build it
  with a raycaster, or use a connector.
- [Why Google Analytics can't see inside a 3D scene](/docs/learn/google-analytics-3d-scenes/): what
  GA4 can and can't tell you, and how to use both.
- [Session replay for WebGL and 3D scenes](/docs/learn/webgl-session-replay/): recording pixels
  compared with re-driving events.
- [Measure real-user FPS in WebGL](/docs/learn/webgl-real-user-performance/): why your own GPU isn't
  a useful benchmark.
- [Analytics for 3D product configurators](/docs/learn/3d-product-configurator-analytics/): which
  options get attention, and where shoppers stop.
- [Analytics for Unity, Godot and Unreal web exports](/docs/learn/unity-godot-unreal-web-analytics/):
  what you can capture with and without engine code.
- [Uptimizr vs Cognitive3D](/docs/learn/cognitive3d-alternative/): how to choose between them.

## Try it

Uptimizr is an open-source, self-hosted implementation of everything above. You can
[try the live demo](https://demo.uptimizr.com) in your browser with no server, or follow the
[Quickstart](/docs/quickstart/) to add it to your own scene.
