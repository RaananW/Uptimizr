"use client";

import { useEffect, useRef, useState } from "react";
import { CollectorApi, type TrajectoryPoint } from "@/lib/api";
import { Panel } from "./Panel";

const SIZE = 360;
const PAD = 16;

/**
 * Top-down walked-path view for a single session (ADR 0026): the ordered
 * `camera_sample` positions projected onto the X/Z ground plane and connected
 * oldest→newest, with start (green) and end (red) markers. The first-person
 * analog of the session pointer heatmap — it shows the route a visitor took
 * through a walkable scene. Self-fetches so the parent only passes identifiers.
 */
export function TrajectoryView({
  baseUrl,
  apiKey,
  sessionId,
  scene,
}: {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  scene?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState<TrajectoryPoint[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const api = new CollectorApi(baseUrl, apiKey);
    api
      .sessionTrajectory(sessionId, { scene, limit: 5000 })
      .then((rows) => {
        if (cancelled) return;
        setPoints(rows);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setPoints([]);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, apiKey, sessionId, scene]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, SIZE, SIZE);

    if (points.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const span = Math.max(maxX - minX, maxZ - minZ, 1e-3);
    const scale = (SIZE - PAD * 2) / span;
    // Project world (x, z) → canvas (px, py); flip Z so smaller world Z is up.
    const project = (p: TrajectoryPoint): [number, number] => [
      PAD + (p.x - minX) * scale,
      PAD + (maxZ - p.z) * scale,
    ];

    ctx.lineWidth = 2;
    ctx.strokeStyle = "#38bdf8";
    ctx.beginPath();
    points.forEach((p, i) => {
      const [px, py] = project(p);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    const first = points[0];
    const last = points[points.length - 1];
    if (first) {
      const [sx, sy] = project(first);
      ctx.fillStyle = "#22c55e";
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (last) {
      const [ex, ey] = project(last);
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(ex, ey, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [points]);

  return (
    <Panel
      title="Walked path"
      subtitle="Camera trajectory (top-down)"
      help="The ordered route this session's camera took across the X/Z ground plane — green is the start, red is the end. Meaningful for first-person (walkable) sessions."
    >
      <div className="flex justify-center">
        <canvas
          ref={ref}
          width={SIZE}
          height={SIZE}
          className="rounded-lg border border-edge"
          aria-label="Session camera trajectory"
        />
      </div>
      {status === "loading" ? (
        <p className="mt-2 text-center text-xs text-fg-muted">Loading trajectory…</p>
      ) : status === "error" ? (
        <p className="mt-2 text-center text-xs text-red-400">Failed to load trajectory.</p>
      ) : points.length === 0 ? (
        <p className="mt-2 text-center text-xs text-fg-muted">
          No camera movement recorded for this session.
        </p>
      ) : null}
    </Panel>
  );
}
