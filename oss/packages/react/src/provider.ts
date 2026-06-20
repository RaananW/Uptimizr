"use client";

import { createContext, createElement, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { CollectorApi } from "./api";

interface UptimizrContextValue {
  api: CollectorApi;
  endpoint: string;
}

const UptimizrContext = createContext<UptimizrContextValue | null>(null);

/**
 * Configure the collector connection for every `@uptimizr/react` panel rendered
 * beneath it. Panels read the collector's query API through the shared
 * {@link CollectorApi} client — browser → query API only, never the database.
 */
export function UptimizrProvider({
  endpoint,
  apiKey,
  children,
}: {
  /** Base URL of the collector (e.g. `http://localhost:4318`). */
  endpoint: string;
  /** Project API key minted by `uptimizr init` / `uptimizr new-project`. */
  apiKey: string;
  children: ReactNode;
}) {
  const value = useMemo<UptimizrContextValue>(
    () => ({ api: new CollectorApi(endpoint, apiKey), endpoint }),
    [endpoint, apiKey],
  );
  return createElement(UptimizrContext.Provider, { value }, children);
}

/** Access the active provider's collector connection. Throws if unconfigured. */
export function useUptimizr(): UptimizrContextValue {
  const ctx = useContext(UptimizrContext);
  if (!ctx) {
    throw new Error("useUptimizr must be used inside an <UptimizrProvider>.");
  }
  return ctx;
}

/** Shortcut for the shared {@link CollectorApi} client from the provider. */
export function useCollectorApi(): CollectorApi {
  return useUptimizr().api;
}
