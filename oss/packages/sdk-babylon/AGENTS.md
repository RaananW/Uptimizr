# AGENTS.md — @uptimizr/babylon

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The Babylon.js connector for Uptimizr. It registers as an `@uptimizr/sdk-core` **collector** and
captures camera pose (view-direction heatmap), pointer move/click (screen heatmaps), mesh picks
(object engagement), and FPS (perf).

`@babylonjs/core` is a **peer dependency** — every Babylon import is type-only, so the connector
reads the host application's scene by duck typing and never bundles or mutates it.

## Install

```bash
pnpm add @uptimizr/babylon
# @babylonjs/core is a peer dependency provided by your app.
```

## Canonical usage

```ts
import { trackScene } from "@uptimizr/babylon";

const client = trackScene(scene, {
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
// ... later
await client.stop("manual");
```

`trackScene` returns the `@uptimizr/sdk-core` `UptimizrClient`, so you can read
`client.sessionId`, emit custom events, or stop it.

### Advanced (compose it yourself)

```ts
import { UptimizrClient } from "@uptimizr/sdk-core";
import { babylonCollector, readDeviceCaps } from "@uptimizr/babylon";

const client = new UptimizrClient({
  projectId: "your-project",
  endpoint: "https://collect.example.com",
});
client.use(babylonCollector({ scene }));
client.start({ device: readDeviceCaps(scene) });
```

## Capture knobs

`sampleCameraMs`, `samplePerfMs`, `pointerMoveThrottleMs`, and a `capture` toggle map. The
`sampling` profile sets per-channel fidelity in Hz (`0` = off, `"frame"` = every tick) for
continuous channels only — camera, pointer move, perf (ADR 0012). Discrete events (clicks, picks,
custom) are always captured.

## Rules for agents

- Treat `@babylonjs/core` as a peer dependency; keep Babylon imports **type-only**.
- Emit only `@uptimizr/schema` events; do not redefine event shapes.
- Pointer/mesh events carry an input `source` (`mouse`/`touch`/`pen`, ADR 0011) — do not strip it.
- To support another engine, create a sibling package depending only on `@uptimizr/sdk-core` and
  `@uptimizr/schema`; see the repo `add-connector` skill.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
