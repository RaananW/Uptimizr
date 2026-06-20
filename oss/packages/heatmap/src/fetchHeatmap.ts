import type { GazeBin, GazeData } from "./gaze.js";
import type { HeatmapData, HeatmapVoxel } from "./types.js";

/** Options for {@link fetchWorldHeatmap}. */
export interface FetchWorldHeatmapOptions {
  /** Collector base URL, e.g. `https://collect.example.com`. */
  endpoint: string;
  /** Project API key (sent as `x-api-key`). */
  apiKey: string;
  /** Restrict to one developer-assigned scene id. Omit for all scenes. */
  sceneId?: string;
  /** Restrict to one input source (e.g. `mouse`, `xr-controller`). */
  source?: string;
  /**
   * Voxel edge length, in world units. Must match what the overlay renders with;
   * the collector defaults to `0.5` when omitted.
   */
  cellSize?: number;
  /** Inclusive lower time bound (epoch ms). */
  since?: number;
  /** Inclusive upper time bound (epoch ms). */
  until?: number;
  /** Cap on the number of (busiest) voxels returned. */
  limit?: number;
  /** Override the global `fetch` (for testing or non-browser hosts). */
  fetchImpl?: typeof fetch;
}

/** Coerce a JSON scalar (ClickHouse may serialize integers as strings) to a finite number. */
function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toVoxel(row: unknown): HeatmapVoxel | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  return {
    vx: toNumber(r.vx),
    vy: toNumber(r.vy),
    vz: toNumber(r.vz),
    count: toNumber(r.count),
  };
}

/**
 * Fetch a world-space (voxel) heatmap from the collector's
 * `GET /api/v1/heatmaps/world` endpoint and return it as {@link HeatmapData}
 * ready for {@link "./overlay".HeatmapOverlay}. The returned `cellSize` echoes the
 * requested one (default `0.5`) so the overlay positions voxels with the same
 * grid the server binned them on.
 */
export async function fetchWorldHeatmap(options: FetchWorldHeatmapOptions): Promise<HeatmapData> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cellSize = options.cellSize ?? 0.5;

  const params = new URLSearchParams();
  if (options.sceneId !== undefined) params.set("scene", options.sceneId);
  if (options.source !== undefined) params.set("source", options.source);
  params.set("cellSize", String(cellSize));
  if (options.since !== undefined) params.set("since", String(options.since));
  if (options.until !== undefined) params.set("until", String(options.until));
  if (options.limit !== undefined) params.set("limit", String(options.limit));

  const url = `${options.endpoint}/api/v1/heatmaps/world?${params.toString()}`;
  const res = await fetchImpl(url, { headers: { "x-api-key": options.apiKey } });
  if (!res.ok) {
    throw new Error(`world heatmap fetch failed: ${res.status}`);
  }

  const body: unknown = await res.json();
  const rows = Array.isArray(body) ? body : [];
  const voxels: HeatmapVoxel[] = [];
  for (const row of rows) {
    const voxel = toVoxel(row);
    if (voxel) voxels.push(voxel);
  }
  return { voxels, cellSize };
}

/** Options for {@link fetchGazeHeatmap}. */
export interface FetchGazeHeatmapOptions {
  /** Collector base URL, e.g. `https://collect.example.com`. */
  endpoint: string;
  /** Project API key (sent as `x-api-key`). */
  apiKey: string;
  /** Restrict to one developer-assigned scene id. Omit for all scenes. */
  sceneId?: string;
  /** Restrict to a single session id. Omit to aggregate across sessions. */
  sessionId?: string;
  /**
   * Grid resolution (bins per axis) for the spherical binning. Must match what
   * the overlay reconstructs with; the collector defaults to `36` when omitted.
   */
  bins?: number;
  /** Inclusive lower time bound (epoch ms). */
  since?: number;
  /** Inclusive upper time bound (epoch ms). */
  until?: number;
  /** Override the global `fetch` (for testing or non-browser hosts). */
  fetchImpl?: typeof fetch;
}

function toGazeBin(row: unknown): GazeBin | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  return {
    azimuthBin: toNumber(r.azimuth_bin),
    elevationBin: toNumber(r.elevation_bin),
    count: toNumber(r.count),
  };
}

/**
 * Fetch a gaze (camera view-direction) heatmap from the collector's
 * `GET /api/v1/heatmaps/camera` endpoint and return it as {@link GazeData} ready
 * for {@link "./gaze".GazeOverlay}. The returned `gridSize` echoes the requested
 * `bins` (default `36`) so the overlay reconstructs directions with the same grid
 * the server binned them on.
 */
export async function fetchGazeHeatmap(options: FetchGazeHeatmapOptions): Promise<GazeData> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const gridSize = options.bins ?? 36;

  const params = new URLSearchParams();
  if (options.sceneId !== undefined) params.set("scene", options.sceneId);
  if (options.sessionId !== undefined) params.set("session", options.sessionId);
  params.set("bins", String(gridSize));
  if (options.since !== undefined) params.set("since", String(options.since));
  if (options.until !== undefined) params.set("until", String(options.until));

  const url = `${options.endpoint}/api/v1/heatmaps/camera?${params.toString()}`;
  const res = await fetchImpl(url, { headers: { "x-api-key": options.apiKey } });
  if (!res.ok) {
    throw new Error(`gaze heatmap fetch failed: ${res.status}`);
  }

  const body: unknown = await res.json();
  const rows = Array.isArray(body) ? body : [];
  const bins: GazeBin[] = [];
  for (const row of rows) {
    const bin = toGazeBin(row);
    if (bin) bins.push(bin);
  }
  return { bins, gridSize };
}
