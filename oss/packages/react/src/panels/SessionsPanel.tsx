"use client";

import type { QueryParams, SessionSummary } from "../api";
import { useCollectorApi } from "../provider";
import { useAsync } from "../useAsync";
import { PanelCard, PanelMessage } from "./PanelCard";
import { SessionsTableView } from "./views";

/**
 * Most-recent sessions for the configured project. Self-fetching: reads the
 * collector through the shared client and renders the shared table view.
 */
export function SessionsPanel({
  params,
  onSelect,
  selectedId,
}: {
  /** Time range / scene / limit filters forwarded to the query API. */
  params?: QueryParams;
  onSelect?: (sessionId: string) => void;
  selectedId?: string;
}) {
  const api = useCollectorApi();
  const key = JSON.stringify(params ?? {});
  const { data, loading, error } = useAsync<SessionSummary[]>(
    () => api.sessions(params),
    [api, key],
  );

  return (
    <PanelCard title="Sessions" subtitle={data ? `${data.length} most recent` : "Loading…"}>
      {loading ? (
        <PanelMessage>Loading…</PanelMessage>
      ) : error ? (
        <PanelMessage>Could not load sessions: {error.message}</PanelMessage>
      ) : (
        <SessionsTableView sessions={data ?? []} onSelect={onSelect} selectedId={selectedId} />
      )}
    </PanelCard>
  );
}
