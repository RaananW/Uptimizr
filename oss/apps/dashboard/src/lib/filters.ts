// The dashboard's global filter state lives in `@uptimizr/react` so the panel
// contract (ADR 0036) and any embedding app share one definition. This module
// re-exports that single source; import filter helpers from `@/lib/filters` as
// before.

export {
  DEFAULT_FILTERS,
  TIME_PRESETS,
  INPUT_SOURCES,
  resolveRange,
  toQueryParams,
  pickInterval,
  formatSource,
} from "@uptimizr/react";
export type { FilterState, TimeWindow } from "@uptimizr/react";
