import { z } from "zod";
import { sceneIdSchema } from "./primitives.js";
import { LIMITS } from "./limits.js";

/**
 * **Conditional subscriptions** — the push half of the agent surface
 * (ADR 0051 §6, design sketch §F.1).
 *
 * A subscription is a standing question: *"tell me when this metric does this."*
 * It names a registry metric, a window, a predicate over that window, and where
 * to deliver a firing. The collector evaluates it in-process — on a timer for
 * the store-backed predicates, on the live bus (ADR 0032) for the ones that can
 * be answered from arriving events — and delivers over SSE and/or a signed
 * webhook.
 *
 * Like `funnel.ts` and `sceneRegion.ts` this is a **config / metadata** shape,
 * not an analytics event: it is deliberately not part of the event union and
 * never reaches the public ingest path. It is still a wire contract (the CRUD
 * endpoint, the CLI and the MCP write tool all send it), so it lives here and is
 * validated at the boundary.
 *
 * ## Two things this contract deliberately constrains
 *
 * 1. **The window is at least an hour.** The portable per-bucket series the
 *    evaluator reads (`@uptimizr/db`'s insight `measures`/`buckets`) has exactly
 *    two grains, `hour` and `day`, because those are the only two that render
 *    identically on DuckDB, ClickHouse, Postgres and SQL Server. A `15m` window
 *    would therefore have to be silently widened to an hour, and a subscription
 *    that measures something other than what it says is worse than one that
 *    refuses to be created. `evaluate.every` is unconstrained by this — checking
 *    a one-hour rolling window every minute is perfectly meaningful.
 * 2. **`threshold.column` is the metric's own headline column.** A predicate can
 *    only compare the column the registry declares as the metric's
 *    `comparable.primary` (`perf_summary` → `p50_fps`), because that is the one
 *    column the portable bucket series reproduces faithfully. The collector
 *    resolves the name against `@uptimizr/metrics` and answers a `400` that
 *    *names* the right column rather than failing at evaluation time.
 *
 * Privacy (ADR 0003): a subscription is project-scoped configuration about
 * *metrics*. It carries no visitor, session or user key, and the delivery secret
 * is write-only — see {@link webhookDeliverySchema}.
 */

/** Bumped when the stored subscription shape changes incompatibly. */
export const SUBSCRIPTION_CONFIG_VERSION = 1;

/** Multiplier from a duration suffix to milliseconds. */
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `12h`, `30m`, `7d` — a positive integer and one of `s`/`m`/`h`/`d`. */
const DURATION_RE = /^([1-9]\d{0,5})(s|m|h|d)$/;

/**
 * Parse a duration literal (`"5m"`, `"24h"`, `"7d"`) to milliseconds, or `null`
 * when it is not one. Pure and allocation-light: the scheduler calls it once per
 * subscription per reload, and the Zod refinements below call it during
 * validation.
 */
export function parseDurationMs(value: string): number | null {
  const match = DURATION_RE.exec(value);
  if (match == null) return null;
  const unit = DURATION_UNIT_MS[match[2] as string];
  if (unit == null) return null;
  return Number(match[1]) * unit;
}

/** Render a millisecond count back to the shortest exact duration literal. */
export function formatDurationMs(ms: number): string {
  for (const [suffix, unit] of [
    ["d", DURATION_UNIT_MS.d],
    ["h", DURATION_UNIT_MS.h],
    ["m", DURATION_UNIT_MS.m],
    ["s", DURATION_UNIT_MS.s],
  ] as const) {
    if (unit != null && ms % unit === 0) return `${ms / unit}${suffix}`;
  }
  return `${Math.round(ms / 1000)}s`;
}

/** Smallest evaluation interval: one minute (ADR 0051 §6 / sketch §F.2). */
export const MIN_EVALUATE_EVERY_MS = 60_000;
/** Largest evaluation interval: a day. */
export const MAX_EVALUATE_EVERY_MS = 86_400_000;
/** Smallest evaluation window: one hour — the finest portable bucket grain. */
export const MIN_EVALUATE_WINDOW_MS = 3_600_000;
/** Largest evaluation window: 30 days. */
export const MAX_EVALUATE_WINDOW_MS = 30 * 86_400_000;
/** Largest cooldown: 7 days. `0s` (no cooldown) is also accepted. */
export const MAX_COOLDOWN_MS = 7 * 86_400_000;

function duration(min: number, max: number, label: string) {
  return z.string().superRefine((value, ctx) => {
    const ms = parseDurationMs(value);
    if (ms == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be a duration like "5m", "2h" or "7d"`,
      });
      return;
    }
    if (ms < min || ms > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be between ${formatDurationMs(min)} and ${formatDurationMs(max)} (got ${value})`,
      });
    }
  });
}

/** How often a subscription is evaluated. Minimum one minute. */
export const evaluateEverySchema = duration(
  MIN_EVALUATE_EVERY_MS,
  MAX_EVALUATE_EVERY_MS,
  "evaluate.every",
);

/**
 * The span each evaluation measures, ending at the moment of evaluation.
 * Minimum one hour — see the module note on bucket grains.
 */
export const evaluateWindowSchema = duration(
  MIN_EVALUATE_WINDOW_MS,
  MAX_EVALUATE_WINDOW_MS,
  "evaluate.window",
);

/** Quiet period after a firing before the same subscription may fire again. */
export const cooldownSchema = z.string().superRefine((value, ctx) => {
  const ms = parseDurationMs(value);
  // `0s` never matches DURATION_RE (the integer part is 1-9 leading), so it is
  // spelled out here: "no cooldown" is a legitimate, explicit choice.
  if (value === "0s" || value === "0m") return;
  if (ms == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cooldown must be a duration like "1h", or "0s" for none',
    });
    return;
  }
  if (ms > MAX_COOLDOWN_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `cooldown must be at most ${formatDurationMs(MAX_COOLDOWN_MS)} (got ${value})`,
    });
  }
});

/** The two portable time grains an evaluation series can be bucketed at. */
export const subscriptionBucketSchema = z.enum(["hour", "day"]);
export type SubscriptionBucket = z.infer<typeof subscriptionBucketSchema>;

/** Comparison operators a `threshold` / `presence` predicate may use. */
export const comparisonOpSchema = z.enum(["<", "<=", ">", ">=", "==", "!="]);
export type ComparisonOp = z.infer<typeof comparisonOpSchema>;

/**
 * The dimensions a `new_value` predicate can watch.
 *
 * Restricted to promoted, low-cardinality columns the store groups by natively
 * and the live bus carries on every event, so "first time we have seen this"
 * costs one grouped read to seed and an O(1) set lookup per arriving event.
 */
export const newValueDimensionSchema = z.enum(["scene", "name", "mesh", "source"]);
export type NewValueDimension = z.infer<typeof newValueDimensionSchema>;

/**
 * Fire when the metric's headline column crosses a level.
 *
 * `column` must be the metric's registry `comparable.primary`; `minSample` is
 * the denominator the window must reach before the comparison is trusted at all
 * (without it, one straggling session at 3am fires every "FPS below 30" alert
 * ever written). It defaults to the metric's own declared `comparable.minSample`.
 */
export const thresholdPredicateSchema = z.object({
  kind: z.literal("threshold"),
  /** The metric's `comparable.primary` column, e.g. `p50_fps`. */
  column: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, "column must be a lower_snake_case identifier"),
  op: comparisonOpSchema,
  value: z.number().finite(),
  /** Minimum window sample size before the comparison counts. */
  minSample: z.number().int().nonnegative().max(1_000_000).optional(),
});

/**
 * Fire when the `anomalies` primitive (ADR 0051 §4) reports the most recent
 * buckets of the window as abnormal. `sensitivity` is the robust-z threshold it
 * delegates straight through.
 */
export const anomalyPredicateSchema = z.object({
  kind: z.literal("anomaly"),
  sensitivity: z.number().min(1).max(12).optional(),
});

/**
 * Fire when the metric moved by more than `pct` percent against the immediately
 * preceding equal window — the `movers` primitive's own comparison, standing.
 * `direction` narrows it to rises or falls only.
 */
export const moversPredicateSchema = z.object({
  kind: z.literal("movers"),
  /** Absolute percentage change that counts as a move, e.g. `25` for ±25%. */
  pct: z.number().positive().max(100_000),
  direction: z.enum(["up", "down", "any"]).optional(),
});

/**
 * Fire the first time a value of `dimension` is seen that was not present in the
 * preceding reference window — "a new scene appeared", "a custom event we have
 * never recorded before".
 */
export const newValuePredicateSchema = z.object({
  kind: z.literal("new_value"),
  dimension: newValueDimensionSchema,
});

/**
 * Fire on live presence (ADR 0032) crossing a level — "nobody is in the scene",
 * "more than 50 concurrent sessions". Evaluated on the live bus, so it needs no
 * store query and no window.
 */
export const presencePredicateSchema = z.object({
  kind: z.literal("presence"),
  op: comparisonOpSchema,
  /** Concurrent live sessions to compare against. */
  value: z.number().int().nonnegative().max(1_000_000),
});

/** Closed union of everything a subscription can watch for (sketch §F.1). */
export const subscriptionPredicateSchema = z.discriminatedUnion("kind", [
  thresholdPredicateSchema,
  anomalyPredicateSchema,
  moversPredicateSchema,
  newValuePredicateSchema,
  presencePredicateSchema,
]);
export type SubscriptionPredicate = z.infer<typeof subscriptionPredicateSchema>;
export type SubscriptionPredicateKind = SubscriptionPredicate["kind"];

/** Every predicate kind, for error messages and docs. */
export const SUBSCRIPTION_PREDICATE_KINDS = [
  "threshold",
  "anomaly",
  "movers",
  "new_value",
  "presence",
] as const;

/**
 * Predicate kinds answered from the live bus rather than a store query. They
 * carry no window and are never scheduled.
 */
export const BUS_BACKED_PREDICATE_KINDS: readonly SubscriptionPredicateKind[] = [
  "presence",
  "new_value",
];

/** Whether a predicate kind is evaluated on the live bus (ADR 0032). */
export function isBusBackedPredicate(kind: SubscriptionPredicateKind): boolean {
  return BUS_BACKED_PREDICATE_KINDS.includes(kind);
}

/**
 * A signed outbound POST.
 *
 * `secret` is **write-only**: it is accepted on create, stored hashed-at-rest by
 * the collector's store adapters where the engine allows it, and never returned
 * by any read endpoint — `GET /api/v1/subscriptions` answers with a masked
 * placeholder. The body is signed with HMAC-SHA-256 and sent as
 * `X-Uptimizr-Signature: sha256=<hex>` (see `webhookSignature.ts`).
 *
 * `url` must be an absolute `http(s)` URL. The collector additionally applies an
 * operator-controlled host allow-list before any request leaves the process:
 * this is the first surface where a webhook URL arrives over HTTP rather than
 * from the operator's own shell, so `parseWebhookUrl`'s scheme check is not on
 * its own a sufficient SSRF boundary.
 */
export const webhookDeliverySchema = z.object({
  kind: z.literal("webhook"),
  url: z
    .string()
    .max(LIMITS.maxUrlLength)
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "webhook url must be an absolute http(s) URL",
    }),
  /** Shared secret for the HMAC. Write-only; never echoed back. */
  secret: z.string().min(16).max(256).optional(),
});

/** Fan the firing out to whoever is listening on the subscription SSE stream. */
export const sseDeliverySchema = z.object({ kind: z.literal("sse") });

/** Where a firing goes. At least one target; `sse` alone means zero egress. */
export const subscriptionDeliverySchema = z.discriminatedUnion("kind", [
  webhookDeliverySchema,
  sseDeliverySchema,
]);
export type SubscriptionDelivery = z.infer<typeof subscriptionDeliverySchema>;

/** Filters narrowing the metric the subscription watches. */
export const subscriptionFiltersSchema = z.object({
  scene: sceneIdSchema.optional(),
});
export type SubscriptionFilters = z.infer<typeof subscriptionFiltersSchema>;

/** The evaluation cadence and the span each evaluation measures. */
export const subscriptionEvaluateSchema = z.object({
  every: evaluateEverySchema,
  window: evaluateWindowSchema,
  /** Portable series grain; defaults to `hour` for windows up to 7 days. */
  bucket: subscriptionBucketSchema.optional(),
});
export type SubscriptionEvaluate = z.infer<typeof subscriptionEvaluateSchema>;

/**
 * One subscription, exactly as a caller declares it (sketch §F.1). The stored
 * record adds the collector-assigned `id`, `projectId` and firing bookkeeping —
 * see `SubscriptionRecord` in `@uptimizr/db`.
 */
export const subscriptionSchema = z
  .object({
    /** Human-friendly name shown in the dashboard, summaries and agent answers. */
    name: z.string().min(1).max(LIMITS.maxSubscriptionNameLength),
    /**
     * Registry metric id (`@uptimizr/metrics`). Validated as a bounded
     * identifier here and resolved against the registry in the collector, so the
     * `400` can name the metrics that actually have a portable series.
     */
    metric: z.string().min(1).max(64),
    filters: subscriptionFiltersSchema.optional(),
    evaluate: subscriptionEvaluateSchema,
    predicate: subscriptionPredicateSchema,
    /** Quiet period after a firing. Defaults to `1h`. */
    cooldown: cooldownSchema.optional(),
    delivery: z.array(subscriptionDeliverySchema).min(1).max(LIMITS.maxSubscriptionDeliveries),
    /** Evaluated only while enabled. Defaults to `true`. */
    enabled: z.boolean().optional(),
  })
  .superRefine((sub, ctx) => {
    // One webhook target per subscription. Two would double the egress for one
    // firing and make `failures`/`lastError` ambiguous about which one broke.
    const webhooks = sub.delivery.filter((d) => d.kind === "webhook");
    if (webhooks.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delivery"],
        message: "at most one webhook delivery per subscription",
      });
    }
    if (new Set(sub.delivery.map((d) => d.kind)).size !== sub.delivery.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delivery"],
        message: "delivery targets must be distinct by kind",
      });
    }
    // `every` above `window` would leave gaps the subscription never looks at;
    // that is a legitimate sampling choice, so it is allowed. The reverse — a
    // window shorter than the bucket grain — is rejected by the schema above.
  });
export type Subscription = z.infer<typeof subscriptionSchema>;

/**
 * A partial update. Only `enabled` may be patched: everything else changes what
 * the subscription *means*, and silently re-pointing a standing alert is how an
 * on-call rotation ends up watching the wrong thing. Replace it instead.
 */
export const subscriptionPatchSchema = z.object({ enabled: z.boolean() });
export type SubscriptionPatch = z.infer<typeof subscriptionPatchSchema>;

/**
 * The payload of one firing — what a webhook receives and what the SSE stream
 * emits, minus the `summary` block the collector attaches at delivery time.
 *
 * It is deliberately small and self-describing: a receiver (a Slack relay, a
 * GitHub Action, the self-hoster's own agent) can act on it without a second
 * call back to the collector.
 */
export const subscriptionFiringSchema = z.object({
  subscriptionId: z.string(),
  name: z.string(),
  metric: z.string(),
  predicate: z.string(),
  /** Firing time, epoch ms. */
  at: z.number(),
  /** The half-open window the evaluation measured, epoch ms. */
  window: z.object({ since: z.number(), until: z.number() }),
  /** The observed value that satisfied the predicate, when there is one. */
  value: z.number().nullable(),
  /** What the predicate was compared against (a level, an expectation, a set). */
  expected: z.number().nullable(),
  /** The window's denominator — events or distinct sessions. */
  sampleSize: z.number(),
  /** Scene the subscription was scoped to, or `null` for project-wide. */
  scene: z.string().nullable(),
  /** One-line, human-readable account of why it fired. */
  reason: z.string(),
  /** Dimension value behind the firing (`new_value`, attributed anomalies). */
  dimensionValue: z.string().nullable().optional(),
});
export type SubscriptionFiring = z.infer<typeof subscriptionFiringSchema>;
