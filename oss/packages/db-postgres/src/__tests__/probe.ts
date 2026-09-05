import pg from "pg";

/**
 * Probe a Postgres server so the live suites can skip when it is unreachable
 * (default `pnpm test` / CI must stay Docker-free). A short connect timeout
 * keeps the skip decision fast on machines with no server at all.
 */
export async function postgresReachable(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
