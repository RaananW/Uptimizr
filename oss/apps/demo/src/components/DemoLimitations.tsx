/**
 * The honest small print: what this in-browser demo is and isn't. Keeping the
 * limitations visible sets the right expectations versus a self-hosted or hosted
 * collector (which persists data, scales, and serves a whole team).
 */
export function DemoLimitations() {
  return (
    <details className="limitations">
      <summary>What this demo can and can&apos;t do</summary>
      <ul className="limitations__list">
        <li>
          <strong>Ephemeral.</strong> Data lives only in this tab&apos;s memory. Reloading or closing
          the page clears everything — nothing is persisted to disk.
        </li>
        <li>
          <strong>Single visitor.</strong> You are the only person generating events. A real
          deployment aggregates many visitors across many sessions.
        </li>
        <li>
          <strong>Local only.</strong> There is no server, no account, and no network upload. The
          dashboard reads from an in-browser database, not the cloud.
        </li>
        <li>
          <strong>Bounded.</strong> Only the most recent events are kept so the demo stays light on
          your device.
        </li>
      </ul>
      <p className="limitations__cta">
        Ready for the real thing?{" "}
        <a href="https://github.com/RaananW/Uptimizr" target="_blank" rel="noreferrer">
          Self-host the collector
        </a>{" "}
        — same dashboard, your data, your infrastructure.
      </p>
    </details>
  );
}
