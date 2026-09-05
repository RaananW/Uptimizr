import type { MssqlSettings } from "@uptimizr/db";
import {
  createMssqlClient,
  dropMssqlDatabase,
  ensureMssqlDatabase,
  type MssqlClient,
} from "../client.js";

/**
 * Probe a SQL Server so the live suites can skip when it is unreachable
 * (default `pnpm test` / CI must stay Docker-free). The probe connects to
 * `master` (always present) with a short timeout, so the skip decision is fast
 * on machines with no server at all.
 *
 * Set `MSSQL_PARITY_REQUIRED=1` (the "Store parity (MSSQL)" CI job does) to
 * turn an unreachable server into a hard failure instead of a skip, so an
 * outage of the service container can never pass as a green run.
 */
export async function mssqlReachable(settings: MssqlSettings): Promise<boolean> {
  const client = createMssqlClient(settings, { database: "master", connectionTimeout: 3000 });
  try {
    await client.query("SELECT 1 AS ok");
    return true;
  } catch (error) {
    if (process.env.MSSQL_PARITY_REQUIRED) {
      throw new Error(
        `MSSQL_PARITY_REQUIRED is set but SQL Server is unreachable ` +
          `(${settings.url ? "MSSQL_URL" : `${settings.server}:${settings.port}`})`,
        { cause: error },
      );
    }
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Create a throwaway database for one suite and a client bound to it. The
 * suites run in parallel worker processes, so each gets its own database
 * (dropped by {@link discardTestDatabase} on teardown).
 */
export async function openTestDatabase(
  settings: MssqlSettings,
  database: string,
): Promise<MssqlClient> {
  await dropMssqlDatabase(settings, database);
  await ensureMssqlDatabase(settings, database);
  return createMssqlClient(settings, { database });
}

export async function discardTestDatabase(
  settings: MssqlSettings,
  client: MssqlClient | undefined,
  database: string,
): Promise<void> {
  if (client) await client.close().catch(() => {});
  await dropMssqlDatabase(settings, database);
}
