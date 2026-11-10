import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const DB_URL = process.env.DATABASE_URL ?? "postgres://alteva:alteva_password@localhost:5442/alteva_db";
const MIGRATIONS_DIR = new URL("../../../db/migrations/", import.meta.url);
/** Every migration, in order, exactly as the api applies them. */
const MIGRATION = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), "utf8"))
  .join("\n");

export interface TestDb {
  pool: pg.Pool;
  close: () => Promise<void>;
}

/**
 * True when the local Postgres from docker compose answers. DB tests skip otherwise, loudly; set
 * REQUIRE_DB=1 (CI, `pnpm test:integration`) to make an unreachable database a failure instead.
 */
export async function postgresAvailable(): Promise<boolean> {
  const up = await canConnect();
  if (!up && process.env.REQUIRE_DB) throw new Error(`REQUIRE_DB is set but Postgres is not reachable at ${new URL(DB_URL).host}`);
  if (!up) console.warn("Postgres is not reachable: database tests are SKIPPED (docker compose up -d postgres)");
  return up;
}

async function canConnect(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 1_000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

/** A pool bound to a throwaway schema holding the real migration, so tests never touch real tables. */
export async function createTestDb(): Promise<TestDb> {
  const schema = `test_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Pool({ connectionString: DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` });
  await pool.query(MIGRATION);
  return {
    pool,
    close: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

/** Polls until `check` is true, instead of sleeping a fixed time and hoping: robust on a loaded machine. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 8_000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
