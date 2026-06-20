import type { SessionSummary } from "@/lib/api";
import { SessionsTableView } from "@uptimizr/react";
import { Panel } from "./Panel";

export function SessionsTable({
  sessions,
  onSelect,
  selectedId,
}: {
  sessions: SessionSummary[];
  /** Called with a session id when a row is clicked, to open its detail view. */
  onSelect?: (sessionId: string) => void;
  /** The currently opened session id, highlighted in the list. */
  selectedId?: string;
}) {
  return (
    <Panel
      title="Sessions"
      subtitle={
        onSelect
          ? `${sessions.length} most recent · select to drill in`
          : `${sessions.length} most recent`
      }
    >
      <SessionsTableView sessions={sessions} onSelect={onSelect} selectedId={selectedId} />
    </Panel>
  );
}
