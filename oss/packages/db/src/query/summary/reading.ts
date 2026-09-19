/**
 * The `reading` sentence: one plain-English statement of what the result says,
 * assembled **only** from the registry's column semantics (design sketch §B.1).
 *
 * No model is involved, and none may be: `reading` is part of a deterministic
 * API response, so the same rows have to produce the same words on every engine
 * and every process. Everything it can say is therefore a function of the
 * metric's `title`, `grain`, and the `unit` / `label` / `measure` / `axis` / `rateOf`
 * flags on its columns — which is exactly the information the registry exists to
 * hold.
 *
 * The one hard rule enforced by `__tests__/summary.test.ts`: a `reading` never
 * contains `undefined` or `NaN`. Every number goes through the total formatters
 * in `format.ts`, which render a missing or non-finite value as `n/a`.
 */

import type { MetricDefinition } from "@uptimizr/metrics";
import { measureColumn } from "./columns.js";
import {
  formatLabel,
  formatNumber,
  formatQuantity,
  formatShare,
  grainNoun,
  humanizeColumn,
} from "./format.js";
import type {
  ClusterSummary,
  RankedSummary,
  RecordSummary,
  ResultSummary,
  SampleSize,
  SeriesSummary,
  SpatialCluster,
} from "./types.js";

/** "Sample: 412 sessions over 9,130 events." — omitted when nothing is known. */
function sampleSentence(sample: SampleSize): string {
  const parts: string[] = [];
  if (sample.sessions != null) parts.push(`${formatNumber(sample.sessions)} sessions`);
  if (sample.events != null) parts.push(`${formatNumber(sample.events)} events`);
  if (parts.length === 0) return "";
  return ` Sample: ${parts.join(" over ")}.`;
}

/** The empty-result sentence, shared by every grain. */
function nothingMatched(metric: MetricDefinition): string {
  return `${metric.title}: no rows matched the selected range and filters.`;
}

function rankedReading(metric: MetricDefinition, summary: RankedSummary): string {
  if (summary.top.length === 0) return nothingMatched(metric);
  const measure = measureColumn(metric);
  const unit = measure?.[1].unit;
  const [first, second] = summary.top;
  if (measure == null || first == null) {
    const rows = summary.top.length + summary.rest.rows;
    return (
      `${metric.title}: ${formatNumber(rows)} ${grainNoun(metric.grain, rows)} returned in store ` +
      `order; the metric declares no measure column, so they cannot be ranked.` +
      sampleSentence(summary.sampleSize)
    );
  }

  const measureName = humanizeColumn(measure[0]);
  let text = `${metric.title}: ${formatLabel(first.label)} leads on ${measureName} with ${formatQuantity(first.value, unit)}`;
  if (first.share != null) {
    text += ` (${formatShare(first.share)} of ${formatQuantity(summary.total, unit)})`;
  }
  if (second != null) {
    text += `, followed by ${formatLabel(second.label)} with ${formatQuantity(second.value, unit)}`;
    if (second.share != null) text += ` (${formatShare(second.share)})`;
  }
  text += ".";

  if (summary.rest.rows > 0) {
    const held =
      summary.rest.share != null
        ? formatShare(summary.rest.share)
        : formatQuantity(summary.rest.value, unit);
    text +=
      ` The remaining ${formatNumber(summary.rest.rows)} ` +
      `${grainNoun(metric.grain, summary.rest.rows)} hold ${held}.`;
  }
  if (summary.measure != null && !summary.measure.additive) {
    const unitPhrase =
      summary.measure.unit == null
        ? "not an additive quantity"
        : `measured in ${summary.measure.unit}`;
    text +=
      ` Shares are not reported: ${measureName} is ${unitPhrase} and cannot be summed across ` +
      `${grainNoun(metric.grain, 2)}.`;
  }
  return text + sampleSentence(summary.sampleSize);
}

function seriesReading(metric: MetricDefinition, summary: SeriesSummary): string {
  const { series } = summary;
  if (series.points === 0) return nothingMatched(metric);
  const measure = measureColumn(metric);
  const unit = measure?.[1].unit;
  const measureName = measure == null ? "the measure" : humanizeColumn(measure[0]);
  const axisName = humanizeColumn(series.axis);

  if (series.points === 1) {
    return (
      `${metric.title}: a single ${axisName} (${formatLabel(series.firstLabel)}) with ` +
      `${measureName} ${formatQuantity(series.first, unit)} — too few points for a trend.` +
      sampleSentence(summary.sampleSize)
    );
  }

  const slope = series.slope == null ? "" : `, ${formatNumber(series.slope)} per ${axisName}`;
  return (
    `${metric.title}: ${measureName} moved from ${formatQuantity(series.first, unit)} at ` +
    `${formatLabel(series.firstLabel)} to ${formatQuantity(series.last, unit)} at ` +
    `${formatLabel(series.lastLabel)} across ${formatNumber(series.points)} ` +
    `${grainNoun("bucket", series.points)} — trend ${series.trend}${slope}. ` +
    `Low ${formatQuantity(series.min, unit)} at ${formatLabel(series.minLabel)}, high ` +
    `${formatQuantity(series.max, unit)} at ${formatLabel(series.maxLabel)}.` +
    sampleSentence(summary.sampleSize)
  );
}

/**
 * Where a hotspot is **in the scene's own words** (ADR 0051 §2, sketch §B.2):
 * "near `checkout_button` in region `counter` ". Returns `""` when the scene
 * registered nothing that could name it, so the sentence falls back to the grid
 * coordinate it has always reported. The trailing space is deliberate — the
 * caller concatenates it straight onto "centred at", and an unlabelled cluster
 * must produce byte-identical text to before.
 */
function placeOf(cluster: SpatialCluster): string {
  const parts: string[] = [];
  if (cluster.nearestMesh != null) {
    // `distance === 0` means the mesh box contains the centroid — "on" rather
    // than "near", because the hotspot is literally there.
    parts.push(`${cluster.distance === 0 ? "on" : "near"} \`${cluster.nearestMesh}\``);
  }
  if (cluster.region != null) parts.push(`in region \`${cluster.region}\``);
  return parts.length === 0 ? "" : `${parts.join(" ")}, `;
}

function clusterReading(metric: MetricDefinition, summary: ClusterSummary): string {
  const cellNoun = grainNoun(metric.grain, summary.occupiedCells);
  if (summary.occupiedCells === 0) return nothingMatched(metric);
  const densest = summary.clusters[0];
  if (densest == null) {
    return (
      `${metric.title}: ${formatNumber(summary.occupiedCells)} occupied ${cellNoun}, none of ` +
      `which reached the density threshold of ${formatNumber(summary.densityThreshold)}.` +
      sampleSentence(summary.sampleSize)
    );
  }

  const centroid = densest.centroid.map((value) => formatNumber(value)).join(", ");
  const extent = densest.extent.min
    .map((min, axis) => formatNumber((densest.extent.max[axis] ?? min) - min + 1))
    .join("x");
  const weightUnit = summary.measure?.unit;
  let text =
    `${metric.title}: ${formatNumber(summary.clusters.length)} ` +
    `hotspot${summary.clusters.length === 1 ? "" : "s"} over ` +
    `${formatNumber(summary.occupiedCells)} occupied ${cellNoun}. The densest spans ` +
    `${extent} ${cellNoun} ${placeOf(densest)}centred at (${centroid}) on ` +
    `${summary.axes.join("/")}, holding ${formatQuantity(densest.weight, weightUnit)}`;
  text += densest.share == null ? "." : ` (${formatShare(densest.share)}).`;
  // Only name the part of `rest` that actually exists — "0 further clusters" is
  // noise in a sentence meant to be read at a glance.
  const rest: string[] = [];
  if (summary.rest.clusters > 0) {
    rest.push(
      `${formatNumber(summary.rest.clusters)} further cluster${summary.rest.clusters === 1 ? "" : "s"}`,
    );
  }
  if (summary.rest.cells > 0) {
    rest.push(
      `${formatNumber(summary.rest.cells)} looser ${grainNoun(metric.grain, summary.rest.cells)}`,
    );
  }
  if (rest.length > 0) {
    text += ` ${rest.join(" and ")} hold ${formatShare(summary.rest.share)}.`;
  }
  return text + sampleSentence(summary.sampleSize);
}

function recordReading(metric: MetricDefinition, summary: RecordSummary): string {
  const columns = Object.keys(summary.record);
  if (columns.length === 0) return nothingMatched(metric);
  const measure = measureColumn(metric);

  let text: string;
  if (measure == null) {
    const listed = columns
      .slice(0, 3)
      .map((column) => `${humanizeColumn(column)} ${formatLabel(summary.record[column])}`)
      .join(", ");
    text = `${metric.title}: ${listed}.`;
  } else {
    text =
      `${metric.title}: ${humanizeColumn(measure[0])} is ` +
      `${formatQuantity(summary.total, measure[1].unit)}.`;
  }

  for (const [column, rate] of Object.entries(summary.rates)) {
    text +=
      ` ${humanizeColumn(column)} is ${formatShare(rate.value)} of ` +
      `${humanizeColumn(rate.denominator)}.`;
  }
  return text + sampleSentence(summary.sampleSize);
}

/**
 * A summary that has everything but its sentence. Distributive, so the `kind`
 * discriminant survives — a bare `Omit<ResultSummary, "reading">` would collapse
 * the union to its common keys and lose the switch below.
 */
export type UnreadSummary<T = ResultSummary> = T extends unknown ? Omit<T, "reading"> : never;

/** The templated `reading` for a summary that has everything but its sentence. */
export function readingFor(metric: MetricDefinition, summary: UnreadSummary): string {
  switch (summary.kind) {
    case "ranked":
      return rankedReading(metric, { ...summary, reading: "" });
    case "series":
      return seriesReading(metric, { ...summary, reading: "" });
    case "clusters":
      return clusterReading(metric, { ...summary, reading: "" });
    case "record":
      return recordReading(metric, { ...summary, reading: "" });
  }
}
