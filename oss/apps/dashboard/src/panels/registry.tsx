import type { PanelDefinition } from "@uptimizr/react";
import { ossPanelCatalog } from "@uptimizr/react";

/**
 * Built-in panels for the OSS dashboard.
 *
 * The panel catalog is owned by `@uptimizr/react` (ADR 0036 / ADR 0047): the
 * package is the single source of truth for the analytics panels, so the whole
 * OSS panel set can be recreated from it alone. This app is a thin consumer — it
 * renders `ossPanelCatalog` as-is and adds only the dashboard shell (filters,
 * scene selector, session inspector, live wiring, layout).
 *
 * Self-hosters append their own `PanelDefinition`s to this array (build-time
 * registration), or load them at runtime via the remote-panel contract
 * (ADR 0041).
 */
export const builtinPanels: PanelDefinition<unknown>[] = [...ossPanelCatalog];
