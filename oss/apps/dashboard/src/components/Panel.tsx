import { useState, type ReactNode } from "react";

/**
 * Small "?" affordance that reveals an explanatory popover on hover/focus.
 * Used for panels whose data needs a sentence of context (e.g. the Flow Sankey).
 */
export function InfoHint({
  children,
  label = "More information",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={label}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-edge text-[10px] font-bold leading-none text-fg-muted transition hover:border-amber hover:text-fg-hi focus:outline-none focus:ring-1 focus:ring-amber"
      >
        ?
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-6 z-20 w-64 -translate-x-1/2 rounded-md border border-edge bg-ink/95 p-2.5 text-xs font-normal normal-case leading-relaxed tracking-normal text-fg opacity-0 shadow-lg shadow-black/40 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {children}
      </span>
    </span>
  );
}

/** Consistent card/panel wrapper used across the dashboard. */
export function Panel({
  title,
  subtitle,
  help,
  children,
  className = "",
  collapsible = false,
  defaultCollapsed = false,
}: {
  title: string;
  subtitle?: string;
  /** Optional explanatory content shown behind a "?" info hint next to the title. */
  help?: ReactNode;
  children: ReactNode;
  className?: string;
  /** When true, the header doubles as a button that collapses the panel body. */
  collapsible?: boolean;
  /** Initial collapsed state when `collapsible` (defaults to expanded). */
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(collapsible && defaultCollapsed);
  const body = (
    <header className={collapsed ? "" : "mb-3"}>
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg">{title}</h2>
        {collapsible ? (
          <span aria-hidden="true" className="text-xs text-fg-muted">
            {collapsed ? "▸" : "▾"}
          </span>
        ) : null}
        {help ? <InfoHint label={`About: ${title}`}>{help}</InfoHint> : null}
      </div>
      {subtitle ? <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p> : null}
    </header>
  );
  return (
    <section
      className={`rounded-xl border border-edge bg-panel p-4 shadow-lg shadow-black/20 ${className}`}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={collapsed ? "false" : "true"}
          className="w-full text-left"
        >
          {body}
        </button>
      ) : (
        body
      )}
      {collapsed ? null : children}
    </section>
  );
}
