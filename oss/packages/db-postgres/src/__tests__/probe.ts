import pg from "pg";

/**
 * Probe a Postgres server so the live suites can skip when it is unreachable
 * (default `pnpm test` / CI must stay Docker-free). A short connect timeout
 * keeps the skip decision fast on machines with no server at all.
 *
 * Set `POSTGRES_PARITY_REQUIRED=1` (the "Store parity (Postgres)" CI job does)
 * to turn an unreachable server into a hard failure instead of a skip, so an
 * outage of the service container can never pass as a green run.
 */
export async function postgresReachable(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch (error) {
    if (process.env.POSTGRES_PARITY_REQUIRED) {
      throw new Error(
        `POSTGRES_PARITY_REQUIRED is set but Postgres is unreachable at ${connectionString}`,
        { cause: error },
      );
    }
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
