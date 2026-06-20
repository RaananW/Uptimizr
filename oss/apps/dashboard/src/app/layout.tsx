import type { Metadata } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font (no runtime CDN request, keeping the
// dashboard privacy-clean and offline-friendly). The CSS variables are consumed
// by the `--font-display` / `--font-mono` tokens in globals.css.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-space-grotesk",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

// `src/app/icon.svg` is picked up by Next's file-based icon convention, which
// emits a basePath-aware, content-hashed `<link rel="icon">` automatically — so
// we deliberately don't set `metadata.icons` here (a manual `/icon.svg` would
// hardcode the origin root and 404 under a sub-path like `/dashboard`).
export const metadata: Metadata = {
  title: "Uptimizr — 3D Scene Analytics",
  description: "Open-source analytics dashboard for 3D scenes.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${jetBrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
