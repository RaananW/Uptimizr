---
title: Ingestion
description: The collector's batched event ingestion endpoint.
lastUpdated: 2026-11-06
---

The SDK delivers events to a single ingestion endpoint. You normally never call this directly — a
connector's `trackScene` (via `@uptimizr/sdk-core`) batches events and sends them for you — but the
contract is documented here for custom transports and self-hosting.

## `POST /api/v1/collect`

Batched events. The SDK uses `navigator.sendBeacon` (credentialed) and falls back to `fetch` with
`keepalive`. Ingestion is keyless: a browser beacon cannot carry a secret header, so the public
`projectId` in each event's envelope is the credential.

| Property     | Value                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| Method       | `POST`                                                                 |
| Path         | `/api/v1/collect`                                                      |
| Auth         | None. The envelope's public `projectId` must name an existing project. |
| Content-Type | `application/json`                                                     |
| Body         | `{ schemaVersion?, events, meta? }`, with 1–1000 events                |
| Response     | `200 { accepted, rejected }`                                           |

Events are validated against the Zod schemas in `@uptimizr/schema` at the edge; invalid batches are
rejected. Every event carries the shared envelope (ordered, timestamped, keyed by `sessionId`).

| Status | When                                                                     |
| ------ | ------------------------------------------------------------------------ |
| `400`  | The batch failed validation, or its events do not share one `projectId`. |
| `401`  | `unknown project`: the `projectId` does not exist.                       |
| `413`  | The body is over `COLLECTOR_BODY_LIMIT` (default `1048576` bytes).       |
| `429`  | The client is over the ingest budget.                                    |

The ingest budget is per client, separate from the read budget:
`COLLECTOR_INGEST_RATE_LIMIT_MAX` requests (default `300`) per
`COLLECTOR_INGEST_RATE_LIMIT_WINDOW_MS` (default `60000`).

## Delivery behavior

- **Batching.** `@uptimizr/sdk-core` flushes when the batch reaches `batchSize` (default `20`) or
  after `flushIntervalMs` (default `5000`).
- **Beacon first.** Sends use `navigator.sendBeacon` so events survive page unload, falling back to
  `fetch({ keepalive: true })`.
- **Privacy.** No cookies and no persistent client id; the `sessionId` is in-memory only.

## Scene registry (write)

A scene can register a **proxy** of its geometry (per-mesh bounding boxes) so the dashboard's 3D
heatmaps draw against a recognizable backdrop. Unlike ingestion, uploading one needs a project API
key holding `annotate`, so run it from a trusted context rather than a public bundle. Reading a
proxy back needs `query`.

| Method | Path                                     | Purpose                                                              | Body                |
| ------ | ---------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| `PUT`  | `/api/v1/scenes/:sceneId/representation` | Register/replace a scene proxy. `proxy.sceneId` must match the path. | `{ proxy, label? }` |
| `GET`  | `/api/v1/scenes/:sceneId/representation` | Fetch a scene's stored representation. `404` if never registered.    | —                   |
| `GET`  | `/api/v1/scene-representations`          | List registered scenes, without the proxy.                           | —                   |

Each list row is `{ sceneId, label, kind, bounds, contentHash, capturedAt, updatedAt }`.

```bash
curl -X PUT -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"proxy": <SceneProxy>, "label": "Main Lobby"}' \
  "https://collect.example.com/api/v1/scenes/lobby/representation"
```

The proxy is produced client-side by `scanSceneProxy(scene, { sceneId })` in `@uptimizr/babylon`,
`@uptimizr/three` and `@uptimizr/babylon-lite` (`scanSceneProxy(app, { sceneId })` in
`@uptimizr/playcanvas`). On a web export, the engine pushes it over the
[bridge](/docs/connectors/web-export/#options).
