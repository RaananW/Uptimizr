---
title: Ingestion
description: The collector's batched event ingestion endpoint.
---

The SDK delivers events to a single ingestion endpoint. You normally never call this directly — a
connector's `trackScene` (via `@uptimizr/sdk-core`) batches events and sends them for you — but the
contract is documented here for custom transports and self-hosting.

## `POST /api/v1/collect`

Batched events. The SDK uses `navigator.sendBeacon` (credentialed) and falls back to `fetch` with
`keepalive`. Authenticate with the project API key.

| Property      | Value                                              |
| ------------- | -------------------------------------------------- |
| Method        | `POST`                                             |
| Path          | `/api/v1/collect`                                  |
| Auth          | `x-api-key: <project key>`                         |
| Content-Type  | `application/json`                                 |
| Body          | A batch of events, each validated against `@uptimizr/schema` |

Events are validated against the Zod schemas in `@uptimizr/schema` at the edge; invalid batches are
rejected. Every event carries the shared envelope (ordered, timestamped, keyed by `sessionId`).

## Delivery behavior

- **Batching.** `@uptimizr/sdk-core` flushes when the batch reaches `batchSize` (default `20`) or
  after `flushIntervalMs` (default `5000`).
- **Beacon first.** Sends use `navigator.sendBeacon` so events survive page unload, falling back to
  `fetch({ keepalive: true })`.
- **Privacy.** No cookies and no persistent client id; the `sessionId` is in-memory only.

## Scene registry (write)

A scene can register a **proxy** of its geometry (per-mesh bounding boxes) so the dashboard's 3D
heatmaps draw against a recognizable backdrop. Writes use the same project API key.

| Method | Path                                     | Purpose                                                       | Body                |
| ------ | ---------------------------------------- | ------------------------------------------------------------ | ------------------- |
| `PUT`  | `/api/v1/scenes/:sceneId/representation` | Register/replace a scene proxy. `proxy.sceneId` must match the path. | `{ proxy, label? }` |

```bash
curl -X PUT -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"proxy": <SceneProxy>, "label": "Main Lobby"}' \
  "https://collect.example.com/api/v1/scenes/lobby/representation"
```

The proxy is produced client-side by `scanSceneProxy(scene, { sceneId })` in `@uptimizr/babylon`.
