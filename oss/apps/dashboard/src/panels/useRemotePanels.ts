"use client";

import { useEffect, useState } from "react";
import type { PanelDefinition, RemotePanelError } from "@uptimizr/react";
import { fetchPanelManifest, loadRemotePanels } from "@uptimizr/react";
import { getRemotePanelConfig } from "@/panels/remoteConfig";

export interface RemotePanelsState {
  /** Panels successfully loaded from the configured manifest(s). */
  readonly panels: PanelDefinition<unknown>[];
  /** Per-source load failures (manifest or panel), surfaced without throwing. */
  readonly errors: RemotePanelError[];
  /** True while the initial fetch/import is in flight. */
  readonly loading: boolean;
}

const EMPTY: RemotePanelsState = { panels: [], errors: [], loading: false };

/**
 * Discover and load dashboard panels at runtime (ADR 0041).
 *
 * Reads the opt-in {@link getRemotePanelConfig} and, when a manifest URL is
 * configured, fetches each manifest and dynamically imports its panel modules on
 * mount. Loading is fully client-side (the dashboard is a static export), runs
 * once, and never throws — manifest and per-panel failures come back as
 * `errors` so the host can surface them while keeping the grid intact. When no
 * manifest is configured the hook is inert and returns empty state.
 */
export function useRemotePanels(): RemotePanelsState {
  const [state, setState] = useState<RemotePanelsState>(EMPTY);

  useEffect(() => {
    const config = getRemotePanelConfig();
    if (!config.enabled) return;

    let cancelled = false;
    const controller = new AbortController();
    setState({ panels: [], errors: [], loading: true });

    void (async () => {
      const panels: PanelDefinition<unknown>[] = [];
      const errors: RemotePanelError[] = [];
      const seen = new Set<string>();

      for (const manifestUrl of config.manifestUrls) {
        const manifest = await fetchPanelManifest(manifestUrl, { signal: controller.signal });
        if ("code" in manifest) {
          errors.push(manifest);
          continue;
        }
        const result = await loadRemotePanels(manifest, {
          allowOrigins: config.allowOrigins.length > 0 ? config.allowOrigins : undefined,
        });
        errors.push(...result.errors);
        // De-dupe across manifests by panel id (first one wins).
        for (const panel of result.panels) {
          if (seen.has(panel.id)) {
            errors.push({
              source: panel.id,
              code: "invalid-panel",
              message: `Duplicate panel id "${panel.id}" from another manifest — ignored`,
            });
            continue;
          }
          seen.add(panel.id);
          panels.push(panel);
        }
      }

      if (!cancelled) setState({ panels, errors, loading: false });
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return state;
}
