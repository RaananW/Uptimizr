"use client";

import type { Subscription, SubscriptionEvent } from "../../api";

export const SUBSCRIPTIONS_TITLE = "Subscriptions";
export const SUBSCRIPTIONS_SUBTITLE =
  "Standing conditions the collector watches, and how each one last went";

/**
 * Read-only view of the project's conditional subscriptions (#311, ADR 0051 §6).
 *
 * There is deliberately **no authoring UI here**. A subscription is
 * configuration with an outbound side effect — it names a webhook and a secret —
 * and OSS keeps that kind of declaration in a file, a CLI call or an agent's
 * tool call, where it is reviewable and reproducible, rather than in a form
 * (the same stance ADR 0038 takes on funnel steps). What the dashboard owes the
 * operator is the answer to "is it on, and did it work", which is this panel.
 */

/**
 * How many subscriptions' firing logs the panel reads.
 *
 * Each is its own request, and a project may hold a hundred subscriptions — so
 * the panel reads the logs of the few that have actually fired most recently and
 * leaves the rest to `GET /api/v1/subscriptions/:id/events`.
 */
export const SUBSCRIPTION_FIRING_LOGS = 5;

/** What the panel loads: the subscriptions, plus recent firings for a few. */
export interface SubscriptionsPanelData {
  subscriptions: Subscription[];
  /** Subscription id → its most recent firings, newest first. */
  firings: Record<string, SubscriptionEvent[]>;
}

/** The `reason` line of one recorded firing, if the payload carries one. */
export function firingReason(event: SubscriptionEvent): string | null {
  const reason = event.payload.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

/** A subscription's state, reduced to the one thing worth showing as a badge. */
export type SubscriptionHealth = "disabled" | "failing" | "fired" | "idle";

/** Classify one subscription for display. */
export function healthOf(sub: Subscription): SubscriptionHealth {
  if (!sub.enabled) return "disabled";
  // A failure is louder than a firing: a subscription that fired and could not
  // deliver is worse than one that has never fired at all.
  if (sub.failures > 0 || sub.lastError != null) return "failing";
  return sub.lastFiredAt != null ? "fired" : "idle";
}

const BADGE: Readonly<Record<SubscriptionHealth, { label: string; className: string }>> = {
  disabled: { label: "Disabled", className: "border-edge text-fg-muted" },
  failing: { label: "Delivery failing", className: "border-red-500/40 text-red-400" },
  fired: { label: "Fired", className: "border-emerald-500/40 text-emerald-400" },
  idle: { label: "Watching", className: "border-edge text-fg-muted" },
};

/** One-line, human-readable rendering of a predicate. */
export function describePredicate(sub: Subscription): string {
  const p = sub.predicate;
  switch (p.kind) {
    case "threshold":
      return `${sub.metric}.${String(p.column)} ${String(p.op)} ${String(p.value)}`;
    case "anomaly":
      return `${sub.metric} anomaly`;
    case "movers":
      return `${sub.metric} moves by ±${String(p.pct)}%`;
    case "new_value":
      return `new ${String(p.dimension)} on ${sub.metric}`;
    case "presence":
      return `live sessions ${String(p.op)} ${String(p.value)}`;
    default:
      return sub.metric;
  }
}

/** Where a firing goes, as a short list of target kinds. */
export function describeDelivery(sub: Subscription): string {
  const kinds = sub.delivery.map((target) => (target.kind === "webhook" ? "webhook" : "SSE"));
  return kinds.length > 0 ? kinds.join(" + ") : "none";
}

/** Relative age of an ISO timestamp, coarse enough to never need a re-render. */
export function formatAge(iso: string | null, now: number = Date.now()): string {
  if (iso == null) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Badge({ health }: { health: SubscriptionHealth }) {
  const { label, className } = BADGE[health];
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}
    >
      {label}
    </span>
  );
}

function Row({ sub, firings }: { sub: Subscription; firings: SubscriptionEvent[] }) {
  const health = healthOf(sub);
  return (
    <li className="rounded-lg border border-edge bg-ink/40 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <p className="truncate text-sm font-medium text-fg-hi" title={sub.name}>
          {sub.name}
        </p>
        <Badge health={health} />
      </div>
      <p className="mt-0.5 truncate text-xs text-fg-muted" title={describePredicate(sub)}>
        {describePredicate(sub)}
        {sub.filters.scene ? ` · ${sub.filters.scene}` : ""}
      </p>
      <p className="mt-1 text-xs text-fg-muted tabular-nums">
        every {sub.evaluate.every} over {sub.evaluate.window} · {describeDelivery(sub)} · last fired{" "}
        {formatAge(sub.lastFiredAt)}
      </p>
      {sub.lastError != null ? (
        <p className="mt-1 break-words text-xs text-red-400" title={sub.lastError}>
          {sub.failures > 0 ? `${sub.failures}× ` : ""}
          {sub.lastError}
        </p>
      ) : null}
      {firings.length > 0 ? (
        <ol className="mt-2 space-y-1 border-t border-edge pt-2">
          {firings.map((event) => (
            <li key={event.id} className="text-xs text-fg-muted">
              <span className="tabular-nums">{formatAge(event.at)}</span>
              {" — "}
              {firingReason(event) ?? "fired"}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

/** Panel BODY only (no chrome); the host supplies title/subtitle via ADR 0036. */
export function SubscriptionsView({
  rows,
  firings = {},
}: {
  rows: Subscription[];
  /** Recent firings per subscription id; absent entries simply show none. */
  firings?: Record<string, SubscriptionEvent[]>;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No subscriptions configured. Create one with{" "}
        <code className="rounded bg-ink/60 px-1">uptimizr subscriptions add --file sub.json</code>{" "}
        or <code className="rounded bg-ink/60 px-1">POST /api/v1/subscriptions</code>.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {rows.map((sub) => (
        <Row key={sub.id} sub={sub} firings={firings[sub.id] ?? []} />
      ))}
    </ul>
  );
}
