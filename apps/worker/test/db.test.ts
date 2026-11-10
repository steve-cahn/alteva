import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPool, withTransaction } from "../src/db";
import { isTransient, isTransientDbError } from "../src/errors";
import { createTestDb, postgresAvailable, type TestDb } from "./helpers";

const dbUp = await postgresAvailable();
const URL = process.env.DATABASE_URL ?? "postgres://alteva:alteva_password@localhost:5442/alteva_db";

describe.skipIf(!dbUp)("the connection pool's limits (postgres)", () => {
  const pools: pg.Pool[] = [];
  const pool = (overrides: pg.PoolConfig = {}) => {
    const p = createPool(URL, "alteva-test", overrides);
    pools.push(p);
    return p;
  };
  afterAll(async () => void (await Promise.all(pools.map((p) => p.end()))));

  const failure = async (promise: Promise<unknown>) => promise.then(() => null, (err) => err as Error & { code?: string });

  it("sets production limits on every connection, and names the application", async () => {
    const { rows } = await pool().query(
      "SELECT current_setting('statement_timeout') st, current_setting('lock_timeout') lt, current_setting('idle_in_transaction_session_timeout') it, current_setting('application_name') app",
    );
    expect(rows[0]).toEqual({ st: "1min", lt: "30s", it: "1min", app: "alteva-test" });
  });

  it("stops a statement that runs too long, with an error the retry queue treats as transient", async () => {
    const err = await failure(pool({ statement_timeout: 150 }).query("SELECT pg_sleep(5)"));
    expect(err?.code).toBe("57014");
    expect(isTransientDbError(err)).toBe(true);
    expect(isTransient(err)).toBe(true);
  });

  it("stops waiting for a lock held too long, again as a transient error", async () => {
    const db: TestDb = await createTestDb();
    try {
      const { rows } = await db.pool.query("INSERT INTO jobs (url, start_host) VALUES ('https://s.test/', 's.test') RETURNING id");
      const holder = await db.pool.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE", [rows[0].id]); // holds the job row lock

      const waiter = new pg.Pool({ connectionString: URL, options: db.pool.options.options, lock_timeout: 150, max: 1 });
      pools.push(waiter);
      const err = await failure(withTransaction(waiter, (c) => c.query("SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE", [rows[0].id])));

      expect(err?.code).toBe("55P03");
      expect(isTransientDbError(err)).toBe(true);
      await holder.query("ROLLBACK");
      holder.release();
    } finally {
      await db.close();
    }
  });

  it("ends a transaction a client left open, so it cannot hold locks forever", async () => {
    const p = pool({ idle_in_transaction_session_timeout: 200 });
    const client = await p.connect();
    client.on("error", () => {}); // the server terminating the session is the point of this test
    await client.query("BEGIN");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const err = await failure(client.query("SELECT 1"));
    expect(err).not.toBeNull(); // the session was terminated out from under it
    client.release(err ?? undefined);
  });

  it("does not time out ordinary quick statements or transactions", async () => {
    const p = pool();
    expect((await p.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
    expect(await withTransaction(p, async (c) => (await c.query("SELECT 2 AS two")).rows[0].two)).toBe(2);
  });
});
