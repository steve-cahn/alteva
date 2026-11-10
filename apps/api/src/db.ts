import pg, { type Pool, type PoolClient, type PoolConfig } from "pg";

/**
 * The connection pool, with the limits a long-running service needs: a hung query or a client that
 * died mid-transaction must not hold locks or connections indefinitely. (Migrations lift the
 * statement timeout for themselves; see migrate.ts.)
 */
export function createPool(connectionString: string, applicationName: string, overrides: PoolConfig = {}): Pool {
  return new pg.Pool({
    connectionString,
    application_name: applicationName,
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    statement_timeout: 60_000,
    lock_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
    ...overrides,
  });
}

/** Runs `fn` in one transaction: commit on success, rollback and rethrow on failure. */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
