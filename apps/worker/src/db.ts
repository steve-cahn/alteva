import pg, { type Pool, type PoolClient, type PoolConfig } from "pg";

/**
 * The connection pool, with the limits a long-running service needs. Without them a hung query, a
 * client that died mid-transaction, or a slow lock holder can pin a job's row lock (and with it every
 * worker on that job) indefinitely. A statement or lock that exceeds these fails with a retryable
 * error (SQLSTATE 57014 / 55P03), which the message retry queue handles.
 */
export function createPool(connectionString: string, applicationName: string, overrides: PoolConfig = {}): Pool {
  return new pg.Pool({
    connectionString,
    application_name: applicationName,
    max: 10, // five concurrent pages (the prefetch), the outbox relay, the health check, and headroom
    connectionTimeoutMillis: 10_000, // waiting for a free or a new connection
    idleTimeoutMillis: 30_000,
    keepAlive: true, // notice a dead connection instead of waiting on it forever
    statement_timeout: 60_000, // no single statement runs longer than this
    lock_timeout: 30_000, // nor waits longer for a lock
    idle_in_transaction_session_timeout: 60_000, // a transaction a crashed client left open cannot hold locks
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
