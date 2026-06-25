"use client";

import { useId } from "react";
import type { AnyPanelSettingValue, PanelSettings, ResolvedPanelSettings } from "@uptimizr/react";

/**
 * Renders a panel's declared {@link PanelSettings} into the host-owned chrome
 * (ADR 0039). Kept deliberately small — a clamped slider (number), a toggle
 * (boolean), and a select (enum) — so the host needs no forms framework. The
 * host persists changes; this component is presentational and stateless.
 */
export function PanelSettingsForm({
  panelId,
  spec,
  values,
  onChange,
  onReset,
  showReset = true,
}: {
  panelId: string;
  spec: PanelSettings;
  values: ResolvedPanelSettings;
  onChange: (key: string, value: AnyPanelSettingValue) => void;
  onReset: () => void;
  showReset?: boolean;
}) {
  const baseId = useId();
  const keys = Object.keys(spec);
  if (keys.length === 0) return null;

  return (
    <div className="space-y-3" data-panel-settings={panelId}>
      {keys.map((key) => {
        const setting = spec[key];
        if (!setting) return null;
        const controlId = `${baseId}-${key}`;
        const label = setting.label ?? key;
        return (
          <div key={key} className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor={controlId} className="text-xs font-medium text-fg">
                {label}
              </label>
              {setting.type === "number" ? (
                <span className="text-xs tabular-nums text-fg-muted">
                  {String(values[key])}
                  {setting.unit ? ` ${setting.unit}` : ""}
                </span>
              ) : null}
            </div>

            {setting.type === "number" ? (
              <input
                id={controlId}
                type="range"
                className="w-full accent-amber"
                min={setting.min}
                max={setting.max}
                step={setting.step ?? 1}
                value={Number(values[key])}
                onChange={(e) => onChange(key, Number(e.target.value))}
              />
            ) : null}

            {setting.type === "boolean" ? (
              <label htmlFor={controlId} className="flex items-center gap-2 text-xs text-fg-muted">
                <input
                  id={controlId}
                  type="checkbox"
                  className="accent-amber"
                  checked={Boolean(values[key])}
                  onChange={(e) => onChange(key, e.target.checked)}
                />
                {setting.help ?? "Enabled"}
              </label>
            ) : null}

            {setting.type === "select" ? (
              <select
                id={controlId}
                className="w-full rounded-md border border-edge bg-ink px-2 py-1 text-xs text-fg"
                value={String(values[key])}
                onChange={(e) => onChange(key, e.target.value)}
              >
                {setting.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label ?? opt.value}
                  </option>
                ))}
              </select>
            ) : null}

            {setting.type !== "boolean" && setting.help ? (
              <p className="text-[11px] leading-tight text-fg-muted">{setting.help}</p>
            ) : null}
          </div>
        );
      })}

      {showReset ? (
        <button
          type="button"
          onClick={onReset}
          className="text-[11px] text-fg-muted underline-offset-2 transition hover:text-amber hover:underline"
        >
          Reset to defaults
        </button>
      ) : null}
    </div>
  );
}
