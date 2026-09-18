---
title: Sessions & lifecycle
description: How sessions start and end, the browser/engine lifecycle events captured, opt-in error capture, and anonymized session context.
---

A **session** is one continuous visit to your 3D experience. It is the unit of replay and the key every
event is timestamped and ordered against.

## Start & end

The session **starts** automatically when you call `trackScene` (it calls `client.start()` for you). It
also **ends** automatically:

- When the tab is closed or navigated away (`pagehide`), the client emits `session_end` (reason
  `"hidden"`) and flushes the final batch via `navigator.sendBeacon` — no events are lost on exit.
- When the tab is merely backgrounded (`visibilitychange` → hidden), queued events flush immediately but
  the session stays open.

For normal page exits you don't have to do anything. Call `client.stop(reason)` to end a session
**explicitly** — e.g. when a single-page app unmounts the 3D view without a navigation:

```ts
await client.stop("manual");
```

`reason` is one of `"manual"` | `"hidden"` | `"unload"` | `"timeout"` (default `"manual"`) and is
recorded on `session_end` alongside `durationMs`. After `stop` the client emits nothing further; call
`trackScene` again to begin a new session.

## Engine & browser lifecycle events

So the timeline reflects everything around the scene — not just camera and pointer activity — the SDK
records these discrete lifecycle events (privacy-safe: dimensions, booleans, and enum states only):

| Event               | Source              | When                                                                   |
| ------------------- | ------------------- | ---------------------------------------------------------------------- |
| `viewport_resize`   | `sdk-core`          | Window resized (debounced) + once at session start.                    |
| `focus_change`      | `sdk-core`          | Window gained/lost focus (`{ focused }`).                              |
| `visibility_change` | `sdk-core`          | Tab shown/hidden (`{ state: "visible" \| "hidden" }`).                 |
| `context_lost`      | `@uptimizr/babylon` | Engine lost its GPU context (rendering suspended).                     |
| `context_restored`  | `@uptimizr/babylon` | Engine recovered its GPU context.                                      |
| `compile_stall`     | `@uptimizr/babylon` | Main-thread shader/pipeline compilation hitch (`durationMs`, `phase`). |
| `capability_change` | _app-reported_      | Fallback/recovery (`kind`, `from`, `to`, `reason`).                    |
| `runtime_error`     | `sdk-core`          | Uncaught JS error / unhandled rejection (opt-in).                      |

The generic browser events are controlled by `captureLifecycle` (default `true`); `viewport_resize` is
debounced by `resizeDebounceMs` (default `250`). Engine context-loss events are controlled by
`capture.contextLoss` (default `true`). `compile_stall` is controlled by `capture.compileStall`
(default `true`) and is **Babylon-only** (three.js has no equivalent engine hook). `capability_change`
is [app-reported](/docs/guides/events/#capability-changes-fallbacks--recovery). The flush-on-hidden and
end-on-`pagehide` behavior is always active, independent of `captureLifecycle`.

## Error capture

`runtime_error` capture is **off by default** and gated by `captureErrors`. When enabled,
`sdk-core` listens for `window` `error` and `unhandledrejection` and emits:

```jsonc
{
  "type": "runtime_error",
  "kind": "error", // or "unhandledrejection"
  "message": "…", // ≤ 1024 chars
  "source": "https://app.example/main.js", // ≤ 1024 chars, optional
  "lineno": 42,
  "colno": 7,
  "stack": "…", // ≤ 4096 chars, optional
}
```

:::caution
Error payloads can carry user data (messages, stack frames, URLs), so capture is **opt-in** and **not
auto-redacted**. Sanitize or drop fields in your
[`beforeSend`](/docs/guides/configuration/#advanced-custom-client--beforesend) hook before they leave
the browser.
:::

To limit noisy loops, consecutive identical `message`+`stack` errors are de-duplicated and capture is
capped at 50 events per session.

## Session context (`meta`, `sceneDescription`, `user`)

`trackScene` attaches context to the one-time `session_start` event. `device` and `scene` are
auto-detected; you supply the rest — all optional:

- **`sceneDescription`** — free-text label for the experience, merged into the auto-detected scene
  metadata.
- **`meta`** — page/area context: `sceneId` (initial scene/area id), `url` (defaults to
  `location.href`), and `pageMeta`.
- **`user`** — caller-supplied, **anonymized** user context (see below).

```ts
const client = trackScene(scene, {
  projectId,
  endpoint,
  sceneDescription: "product-configurator",
  meta: { sceneId: "configurator/step-1", url: location.href, pageMeta: { title: document.title } },
  user: { id: hashedUserId, traits: { plan: "pro", returning: true } },
});
```

### Anonymized user

`user` is **opt-in** and Uptimizr never derives it — you pass it and own the anonymization:

- `user.id` MUST be pseudonymous or hashed — never an email, username, or raw account id. Omit it to
  stay fully anonymous.
- `user.traits` is an open map of **non-identifying** values (`string` / `number` / `boolean` / `null`)
  for segmentation, e.g. `{ plan, locale, returning }`.

```ts
import { createHash } from "node:crypto"; // server-side, or hash before it reaches the client

const hashedUserId = createHash("sha256").update(`${rawUserId}:${dailySalt}`).digest("hex");

trackScene(scene, { projectId, endpoint, user: { id: hashedUserId, traits: { plan: "pro" } } });
```

The user descriptor is surfaced per session at `GET /api/v1/sessions/:id/meta`. The same
`sceneDescription` / `meta` / `user` fields work in the `<script>`-tag form.

## Reading a session's raw timeline

`GET /api/v1/sessions/:id/meta` is a coarse descriptor (device, scene, anonymized user) and needs
only a `query` key. The **ordered raw event stream** that powers
[replay](/docs/guides/replay/) — `GET /api/v1/sessions/:id/events`, and its live sibling
`GET /api/v1/live/sessions/:id` — is gated twice over:

1. the collector must run with `ENABLE_RAW_SESSION_RETENTION=true`, and
2. the API key must hold the `query:raw`
   [capability](/docs/deploy/collector/#api-keys-and-capabilities).

Either half missing answers `403`.

The key `uptimizr init` / `uptimizr new-project` already minted holds `query:raw` — it is the
operator's [owner key](/docs/deploy/collector/#api-keys-and-capabilities) (`query`, `query:raw`,
`annotate`) — so on a fresh self-host only the retention half is left to switch on. To give a
**separate** key the same reach (a standalone replay tool, an agent you trust with raw streams):

```bash
npx -p @uptimizr/collector-server uptimizr new-key <projectId> \
  --capabilities query,query:raw --label "replay"
```

:::caution[Breaking change]
Retention alone used to be enough: any `query` key could read the raw stream once retention was
on. Aggregate endpoints are unaffected and existing keys need no migration, but a key issued
before this change and used for replay or live-follow must be re-minted with `query:raw`.
:::

## Session narrative

The raw stream is built for a **replay driver**, not for a reader: a two-minute session is
thousands of sampled camera poses and frame-perf ticks. `GET /api/v1/sessions/:id/narrative`
answers the human question instead — _what did this session actually do?_ — as an ordered,
compacted account:

```bash
curl -H "x-api-key: $KEY" \
  "https://collect.example.com/api/v1/sessions/<session-id>/narrative?format=text"
```

```text
session 019bf1d4 — 74 events over 41.0s
    0.0s  scene        Session started in scene "lobby" on webgl2.
    2.4s  dwell        Dwelled on "product-hero" for 6.2s (1.1s hovered).
    5.1s  interaction  click on "buy" via mouse.
    9.0s  scene        Moved to scene "configurator".
   12.5s  perf_dip     Frame rate dipped to 14 fps (mean 19) across 6 samples over 3.0s.
   18.2s  interaction  Custom event "add_to_cart" (currency, sku).
   41.0s  end          Session ended (unload) after 41.0s.
   41.0s  summary      74 events over 41.0s: 2 scene(s), 5 mesh(es), 3 interaction(s), 1 perf dip(s), 0 error(s).
```

**It is gated exactly like the raw stream** — `ENABLE_RAW_SESSION_RETENTION` **and** a
`query:raw` key, either one missing is a `403` — because it is derived from the same data. An
unknown session (or one recorded before retention was switched on) is a `404`.

| Parameter      | Default | What it does                                                                      |
| -------------- | ------- | --------------------------------------------------------------------------------- |
| `minDwellMs`   | `1000`  | How long a mesh must hold attention before it earns a `dwell` entry.              |
| `fpsThreshold` | `30`    | A frame sample below this counts towards a dip; two in a row make one `perf_dip`. |
| `maxEntries`   | `200`   | Hard-capped at `1000`. The closing `summary` entry always survives.               |
| `format`       | `full`  | `full` (entries), `table` (the shared `meta` envelope), `text` (the lines above). |

`format=text` exists only on this route and only because of who reads it: a line per entry costs
roughly a third of the tokens of the equivalent JSON, which is what makes a whole session
affordable to put in a model's context.

Each entry is `{ tMs, kind, summary, refs }`, where `kind` is one of `scene`, `dwell`,
`interaction`, `perf_dip`, `error`, `diagnostic`, `capability`, `xr`, `end` or `summary`, and
`refs` names at most a mesh, a scene and a custom-event/input-action name. Timestamps are always
**relative to the session's first event**. What a narrative deliberately leaves out is covered in
[Privacy & retention](/docs/deploy/privacy/#what-a-session-narrative-shows).
