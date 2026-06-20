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
