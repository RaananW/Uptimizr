"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * Minimal, dependency-free card chrome for the embeddable panels. Uses inline
 * styles (not Tailwind) so a panel renders consistently inside any host app.
 * The dark palette matches the standalone dashboard (brand Ember).
 */
const card: CSSProperties = {
  background: "#201913",
  border: "1px solid #34291f",
  borderRadius: 12,
  padding: 16,
  color: "#d8c8b8",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
};

const titleStyle: CSSProperties = { fontSize: 14, fontWeight: 600, color: "#f4eadf" };
const subtitleStyle: CSSProperties = { fontSize: 12, color: "#a8917c", marginTop: 2 };
const bodyStyle: CSSProperties = { marginTop: 12 };
const mutedStyle: CSSProperties = { fontSize: 13, color: "#a8917c" };

export function PanelCard({
  title,
  subtitle,
  children,
  style,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section style={{ ...card, ...style }}>
      <header>
        <div style={titleStyle}>{title}</div>
        {subtitle ? <div style={subtitleStyle}>{subtitle}</div> : null}
      </header>
      <div style={bodyStyle}>{children}</div>
    </section>
  );
}

/** Standard "no data" / loading / error line shared by panels. */
export function PanelMessage({ children }: { children: ReactNode }) {
  return <p style={mutedStyle}>{children}</p>;
}
