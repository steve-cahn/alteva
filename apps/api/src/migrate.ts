import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

// Arbitrary constant: serializes concurrent migrators (e.g. two api replicas starting together).
const MIGRATION_LOCK_ID = 727001;

/** Applies each unapplied `.sql` file in filename order, one transaction per file. Returns the applied names. */
export async function runMigrations(pool: Pool, dir: string): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    for (const name of await listMigrations(dir)) {
      if (done.has(name)) continue;
      await applyMigration(client, name, await readFile(join(dir, name), "utf8"));
      applied.push(name);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}

async function listMigrations(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

async function applyMigration(client: import("pg").PoolClient, name: string, sql: string): Promise<void> {
  try {
    await client.query("BEGIN");
    // A migration may legitimately take a long time (an index on a big table): the pool's statement
    // timeout is for requests, not for this. LOCAL, so it ends with the transaction.
    await client.query("SET LOCAL statement_timeout = 0");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
  }
}
