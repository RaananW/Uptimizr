import type { PerfSummary as PerfSummaryData } from "@/lib/api";
import { PerfSummaryStats } from "@uptimizr/react";
import { Panel } from "./Panel";

export function PerfSummaryPanel({ perf }: { perf: PerfSummaryData | null }) {
  return (
    <Panel title="Rendering performance" subtitle="frame_perf samples">
      <PerfSummaryStats perf={perf} />
    </Panel>
  );
}
